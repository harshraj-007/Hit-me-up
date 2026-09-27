import { describe, expect, it } from "vitest";
import {
  at,
  BOUNDS,
  buildFor,
  DAY_ID,
  makeTask,
  NOW,
  OTHER_DAY_ID,
} from "../../../tests/support/ai-planning-fixtures";
import type { Task } from "@/domain/tasks";
import { parsedFromProposal, validateProposal } from "./validate-proposal";
import type { PlanProposal, ProposedTaskChange, ValidationResult } from "./types";

const MIN = 60_000;
const move = (ref: string, newStart: string, reason = "because"): ProposedTaskChange => ({
  kind: "move",
  ref,
  newStart,
  reason,
});
const unschedule = (ref: string, reason = "because"): ProposedTaskChange => ({
  kind: "unschedule",
  ref,
  reason,
});

function run(tasks: Task[], changes: ProposedTaskChange[], now = NOW): ValidationResult {
  const { state } = buildFor(tasks, now);
  const proposal: PlanProposal = { understood: "ok", changes, unresolved: [] };
  return validateProposal({ state, parsed: parsedFromProposal(proposal) });
}
const codes = (r: ValidationResult) => r.rejected.map((x) => x.code);

describe("valid moves", () => {
  it("18:00–19:00 moved to 20:00 becomes 20:00–21:00 on the same day", () => {
    const task = makeTask({ start: at(18), end: at(19) });
    const r = run([task], [move("t1", "2026-10-01T20:00")]);
    expect(r.status).toBe("valid");
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]).toMatchObject({
      kind: "move",
      taskId: task.id,
      dayId: DAY_ID,
      newStart: at(20),
      newEnd: at(21),
      previousStart: at(18),
      previousEnd: at(19),
    });
    expect(r.baseRevision).toBe(3);
  });

  it("cross-midnight 23:30–01:00 moved to 22:00 becomes 22:00–23:30, same planning day", () => {
    const task = makeTask({ start: at(23, 30), end: at(1, 0, 1) });
    const r = run([task], [move("t1", "2026-10-01T22:00")]);
    expect(r.status).toBe("valid");
    expect(r.accepted[0]).toMatchObject({ newStart: at(22), newEnd: at(23, 30), dayId: DAY_ID });
  });

  it("cross-midnight 23:30–01:00 moved to 23:00 becomes 23:00–00:30 and still crosses midnight", () => {
    const task = makeTask({ start: at(23, 30), end: at(1, 0, 1) });
    const r = run([task], [move("t1", "2026-10-01T23:00")]);
    expect(r.status).toBe("valid");
    expect(r.accepted[0]).toMatchObject({ newStart: at(23), newEnd: at(0, 30, 1), dayId: DAY_ID });
  });

  it("a move that starts inside the day may run past midnight", () => {
    const task = makeTask({ start: at(18), end: at(20) }); // 2h
    const r = run([task], [move("t1", "2026-10-01T23:30")]);
    expect(r.accepted[0]).toMatchObject({ newStart: at(23, 30), newEnd: at(1, 30, 1) });
  });

  it("a moved unscheduled task is re-scheduled", () => {
    const task = makeTask({ start: at(18), end: at(19), unscheduled: true });
    const r = run([task], [move("t1", "2026-10-01T18:00")]);
    expect(r.status).toBe("valid");
    expect(r.accepted[0]).toMatchObject({ kind: "move", previousUnscheduled: true });
  });

  it.each([30, 60, 90, 120])("keeps a %i-minute duration", (minutes) => {
    const task = makeTask({ start: at(12), end: new Date(at(12).getTime() + minutes * MIN) });
    const r = run([task], [move("t1", "2026-10-01T16:00")]);
    const a = r.accepted[0]!;
    if (a.kind !== "move") throw new Error("expected move");
    expect(a.newEnd.getTime() - a.newStart.getTime()).toBe(minutes * MIN);
  });
});

describe("duration protection", () => {
  it("ignores a model-supplied end: the end is always start + stored duration", () => {
    const task = makeTask({ start: at(12), end: at(13, 30) }); // 90 min
    const sneaky = {
      kind: "move",
      ref: "t1",
      newStart: "2026-10-01T16:00",
      reason: "x",
      newEnd: "2026-10-01T19:00",
      durationMinutes: 180,
    } as unknown as ProposedTaskChange;
    const r = run([task], [sneaky]);
    const a = r.accepted[0]!;
    if (a.kind !== "move") throw new Error("expected move");
    expect(a.newEnd).toEqual(at(17, 30));
  });

  it("rejects a move of a task whose stored duration exceeds 24h (window invalid)", () => {
    const task = makeTask({ start: at(10), end: at(11, 0, 1) }); // 25h
    const r = run([task], [move("t1", "2026-10-01T12:00")]);
    expect(codes(r)).toEqual(["window_invalid"]);
  });
});

describe("refs", () => {
  const tasks = () => [1, 2, 3, 4, 5].map((h) => makeTask({ start: at(10 + h), end: at(11 + h) }));

  it("rejects a hallucinated alias", () => {
    const r = run(tasks(), [move("t99", "2026-10-01T20:00")]);
    expect(codes(r)).toEqual(["unknown_ref"]);
    expect(r.status).toBe("invalid");
  });
  it("rejects a real task UUID used as the ref", () => {
    const ts = tasks();
    const r = run(ts, [move(ts[0]!.id, "2026-10-01T20:00")]);
    expect(codes(r)).toEqual(["unknown_ref"]);
    expect(r.rejected[0]!.ref).toBeNull(); // not echoed back as if it were an alias
  });
  it("rejects an alias that only exists in another context", () => {
    const big = tasks();
    const small = big.slice(0, 2);
    const fromBigContext = move("t5", "2026-10-01T20:00");
    expect(codes(run(small, [fromBigContext]))).toEqual(["unknown_ref"]);
  });
  it.each(["__proto__", "constructor", "T1", "t1 ", "", "t1; drop table tasks"])(
    "rejects %j",
    (ref) => {
      expect(codes(run(tasks(), [move(ref, "2026-10-01T20:00")]))).toEqual(["unknown_ref"]);
    },
  );
});

describe("eligibility", () => {
  it("rejects completed and skipped tasks", () => {
    const r = run(
      [
        makeTask({ status: "completed", start: at(12), end: at(13) }),
        makeTask({ status: "skipped", start: at(14), end: at(15) }),
      ],
      [move("t1", "2026-10-01T20:00"), unschedule("t2")],
    );
    expect(codes(r)).toEqual(["resolved_task", "resolved_task"]);
  });
  it("rejects a locked task, for moves and unscheduling", () => {
    const r = run(
      [
        makeTask({ scheduleLocked: true, start: at(12), end: at(13) }),
        makeTask({ scheduleLocked: true, start: at(14), end: at(15) }),
      ],
      [move("t1", "2026-10-01T20:00"), unschedule("t2")],
    );
    expect(codes(r)).toEqual(["locked_task", "locked_task"]);
  });
  it("accepts a user-created task (AI proposal eligibility is separate from isAutoMovable)", () => {
    const r = run(
      [makeTask({ source: "user", start: at(12), end: at(13) })],
      [move("t1", "2026-10-01T20:00")],
    );
    expect(r.status).toBe("valid");
    expect(r.accepted[0]).toMatchObject({ newStart: at(20), newEnd: at(21) });
  });
  it("accepts a planner-created task", () => {
    const r = run(
      [makeTask({ source: "planner", start: at(12), end: at(13) })],
      [move("t1", "2026-10-01T20:00")],
    );
    expect(r.status).toBe("valid");
  });
  it("rejects a fixed task", () => {
    const r = run(
      [makeTask({ kind: "fixed", start: at(12), end: at(13) })],
      [move("t1", "2026-10-01T20:00")],
    );
    expect(codes(r)).toEqual(["not_movable"]);
  });
  it("rejects a task that is in progress", () => {
    const r = run(
      [makeTask({ start: at(8, 30), end: at(9, 30) })],
      [move("t1", "2026-10-01T20:00")],
    );
    expect(codes(r)).toEqual(["not_movable"]);
  });
  it("cannot change planning-day identity: another day's (spillover) task is not movable", () => {
    const spill = makeTask({ dayId: OTHER_DAY_ID, start: at(23, 30, -1), end: at(1) });
    const r = run([spill], [move("t1", "2026-10-01T15:00")]);
    expect(codes(r)).toEqual(["not_movable"]);
  });
});

describe("windows", () => {
  const task = () => makeTask({ start: at(12), end: at(13) });
  it("rejects an unparseable time", () => {
    for (const bad of [
      "not a time",
      "2026-02-30T10:00",
      "2026-10-01T25:00",
      "2026-10-01T10:00:00Z",
    ]) {
      expect(codes(run([task()], [move("t1", bad)]))).toEqual(["invalid_time"]);
    }
  });
  it("rejects a start on another day", () => {
    expect(codes(run([task()], [move("t1", "2026-10-02T00:00")]))).toEqual([
      "outside_planning_day",
    ]);
    expect(codes(run([task()], [move("t1", "2026-09-30T23:00")]))).toEqual([
      "outside_planning_day",
    ]);
  });
  it("rejects a window that has already passed", () => {
    expect(codes(run([task()], [move("t1", "2026-10-01T07:00")]))).toEqual(["in_the_past"]);
  });
  it("rejects a no-op move and unscheduling an unscheduled task", () => {
    expect(codes(run([task()], [move("t1", "2026-10-01T12:00")]))).toEqual(["no_change"]);
    const u = makeTask({ unscheduled: true, start: at(12), end: at(13) });
    expect(codes(run([u], [unschedule("t1")]))).toEqual(["no_change"]);
  });
});

describe("unschedule", () => {
  it("accepts unscheduling an eligible task without touching its stored times", () => {
    const t = makeTask({ start: at(12), end: at(13) });
    const r = run([t], [unschedule("t1")]);
    expect(r.status).toBe("valid");
    expect(r.accepted[0]).toEqual({
      kind: "unschedule",
      changeIndex: 0,
      ref: "t1",
      taskId: t.id,
      dayId: DAY_ID,
      reason: "because",
      previousStart: at(12),
      previousEnd: at(13),
    });
  });
  it("an unscheduled task no longer claims a slot", () => {
    const a = makeTask({ start: at(12), end: at(13) });
    const b = makeTask({ source: "user", start: at(12, 30), end: at(13, 30) });
    expect(run([a, b], [unschedule("t1")]).conflictsAfter).toEqual([]);
  });
});

describe("interactions between changes", () => {
  const tasks = () => [
    makeTask({ start: at(12), end: at(13) }),
    makeTask({ start: at(14), end: at(15) }),
  ];
  it("rejects duplicate changes to one task — no silent winner", () => {
    const r = run(tasks(), [move("t2", "2026-10-01T18:00"), move("t2", "2026-10-01T19:00")]);
    expect(codes(r)).toEqual(["duplicate_change", "duplicate_change"]);
    expect(r.accepted).toEqual([]);
  });
  it("rejects contradictory changes (move + unschedule)", () => {
    const r = run(tasks(), [move("t2", "2026-10-01T18:00"), unschedule("t2")]);
    expect(codes(r)).toEqual(["conflicting_changes", "conflicting_changes"]);
    expect(r.accepted).toEqual([]);
  });
  it("still accepts unrelated valid changes alongside a rejected pair", () => {
    const r = run(tasks(), [
      move("t1", "2026-10-01T18:00"),
      move("t2", "2026-10-01T20:00"),
      unschedule("t2"),
    ]);
    expect(r.accepted.map((a) => a.ref)).toEqual(["t1"]);
    expect(r.status).toBe("partially_valid");
  });
  it("rejects more than 20 changes outright", () => {
    const many = Array.from({ length: 21 }, () => move("t1", "2026-10-01T18:00"));
    const r = run(tasks(), many);
    expect(codes(r)).toEqual(["too_many_changes"]);
    expect(r.status).toBe("invalid");
    expect(r.accepted).toEqual([]);
  });
});

describe("conflicts and status", () => {
  it("surfaces a conflict with an immovable task and is not fully valid", () => {
    const movable = makeTask({ start: at(12), end: at(13) });
    const wall = makeTask({ kind: "fixed", start: at(20), end: at(21) });
    const r = run([movable, wall], [move("t1", "2026-10-01T20:30")]);
    expect(r.accepted).toHaveLength(1);
    expect(r.conflictsAfter).toEqual([
      {
        firstTaskId: wall.id,
        secondTaskId: movable.id,
        firstRef: "t2",
        secondRef: "t1",
        involvesProposal: true,
      },
    ]);
    expect(r.status).toBe("partially_valid");
  });
  it("a conflict that predates the proposal still keeps the result from being valid", () => {
    const a = makeTask({ source: "user", start: at(15), end: at(16) });
    const b = makeTask({ source: "user", start: at(15, 30), end: at(16, 30) });
    const c = makeTask({ start: at(12), end: at(13) });
    const r = run([a, b, c], [move("t1", "2026-10-01T18:00")]);
    expect(r.conflictsAfter).toHaveLength(1);
    expect(r.conflictsAfter[0]!.involvesProposal).toBe(false);
    expect(r.status).toBe("partially_valid");
  });
  it("an empty proposal is invalid (nothing to apply)", () => {
    expect(run([makeTask({ start: at(12), end: at(13) })], []).status).toBe("invalid");
  });
  it("mixed accepted + rejected is partially_valid", () => {
    const r = run(
      [makeTask({ start: at(12), end: at(13) })],
      [move("t1", "2026-10-01T18:00"), move("t9", "2026-10-01T18:00")],
    );
    expect(r.status).toBe("partially_valid");
  });
  it("carries parser rejections and maps changeIndex through sourceIndexes", () => {
    const { state } = buildFor([makeTask({ start: at(12), end: at(13) })]);
    const r = validateProposal({
      state,
      parsed: {
        proposal: {
          understood: "ok",
          changes: [move("t1", "2026-10-01T18:00"), move("t7", "2026-10-01T18:00")],
          unresolved: [],
        },
        sourceIndexes: [0, 2],
        rejected: [{ code: "unsupported_change", message: "no", changeIndex: 1, ref: null }],
      },
    });
    expect(r.rejected.map((x) => [x.changeIndex, x.code])).toEqual([
      [1, "unsupported_change"],
      [2, "unknown_ref"],
    ]);
    expect(r.status).toBe("partially_valid");
  });
});

describe("purity", () => {
  it("does not mutate the state and is repeatable", () => {
    const tasks = [makeTask({ start: at(12), end: at(13) })];
    const { state } = buildFor(tasks);
    const before = JSON.stringify(state.tasks);
    const proposal: PlanProposal = {
      understood: "ok",
      changes: [move("t1", "2026-10-01T18:00")],
      unresolved: [],
    };
    const r1 = validateProposal({ state, parsed: parsedFromProposal(proposal) });
    const r2 = validateProposal({ state, parsed: parsedFromProposal(proposal) });
    expect(JSON.stringify(state.tasks)).toBe(before);
    expect(r2).toEqual(r1);
    expect(BOUNDS.start).toEqual(state.dayBounds.start);
  });
});
