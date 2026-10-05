import { describe, expect, it } from "vitest";
import type { TaskHistoryEntry } from "@/domain/tasks";
import { at, makeTask, PLANNING_DATE, TZ } from "../../../tests/support/ai-planning-fixtures";
import { computeEodFacts, eodStateCanonical, type ComputeEodFactsInput } from "./index";

/** 21:00 UTC on the planning day — the evening the review is written. */
const EVENING = at(21);

function history(
  taskId: string,
  over: Partial<TaskHistoryEntry> & Pick<TaskHistoryEntry, "event">,
): TaskHistoryEntry {
  return {
    id: `h-${Math.random().toString(36).slice(2)}`,
    taskId,
    previousStatus: "upcoming",
    newStatus: "upcoming",
    source: "user",
    previousStart: null,
    previousEnd: null,
    newStart: null,
    newEnd: null,
    revisionId: null,
    changedAt: at(10),
    ...over,
  };
}

function facts(over: Partial<ComputeEodFactsInput> = {}) {
  return computeEodFacts({
    planningDate: PLANNING_DATE,
    timezone: TZ,
    now: EVENING,
    tasks: [],
    history: [],
    revisions: [{ revisionNumber: 1 }],
    ...over,
  });
}

const done = (over = {}) =>
  makeTask({ status: "completed", completedAt: at(12), start: at(11), end: at(13), ...over });

describe("computeEodFacts — outcomes", () => {
  it("classifies every outcome from persisted state and the clock alone", () => {
    const tasks = [
      done({ title: "on time", start: at(8), end: at(9), completedAt: at(8, 50) }),
      done({ title: "late", start: at(9), end: at(10), completedAt: at(10, 45) }),
      makeTask({ title: "skipped", status: "skipped", start: at(10), end: at(11) }),
      makeTask({ title: "slipped", start: at(14), end: at(15) }),
      makeTask({ title: "running", start: at(20), end: at(22) }),
      makeTask({ title: "later", start: at(22), end: at(23) }),
      makeTask({ title: "no room", unscheduled: true, start: at(16), end: at(17) }),
    ];
    const byTitle = Object.fromEntries(facts({ tasks }).tasks.map((t) => [t.title, t.outcome]));
    expect(byTitle).toEqual({
      "on time": "completed_on_time",
      late: "completed_late",
      skipped: "skipped",
      slipped: "slipped",
      running: "in_progress",
      later: "not_yet_due",
      "no room": "unscheduled",
    });
  });

  it("a task completed exactly at its scheduled end is on time, one minute after is late", () => {
    const f = facts({
      tasks: [
        done({ title: "edge", start: at(9), end: at(10), completedAt: at(10) }),
        done({ title: "over", start: at(11), end: at(12), completedAt: at(12, 1) }),
      ],
    });
    expect(f.tasks.map((t) => [t.title, t.outcome, t.minutesLate])).toEqual([
      ["edge", "completed_on_time", null],
      ["over", "completed_late", 1],
    ]);
  });

  it("minutesLate: minutes past the end for a late completion, and for a slipped task since its end as of now", () => {
    const f = facts({
      tasks: [
        done({ title: "late", start: at(9), end: at(10), completedAt: at(10, 45) }),
        makeTask({ title: "slipped", start: at(14), end: at(15) }),
      ],
    });
    expect(f.tasks.find((t) => t.title === "late")!.minutesLate).toBe(45);
    expect(f.tasks.find((t) => t.title === "slipped")!.minutesLate).toBe(6 * 60); // 15:00 → 21:00
  });

  it("is a pure function: the same rows at the same instant give identical facts", () => {
    const tasks = [done(), makeTask({ start: at(14), end: at(15) })];
    expect(facts({ tasks })).toEqual(facts({ tasks }));
  });

  it("the clock moves outcomes of UNRESOLVED tasks only — a resolved task's outcome never changes", () => {
    const tasks = [done({ title: "d" }), makeTask({ title: "u", start: at(20), end: at(22) })];
    const earlier = facts({ tasks, now: at(19) });
    const later = facts({ tasks, now: at(23) });
    expect(earlier.tasks.find((t) => t.title === "d")!.outcome).toBe(
      later.tasks.find((t) => t.title === "d")!.outcome,
    );
    expect(earlier.tasks.find((t) => t.title === "u")!.outcome).toBe("not_yet_due");
    expect(later.tasks.find((t) => t.title === "u")!.outcome).toBe("slipped");
  });
});

describe("computeEodFacts — totals", () => {
  const tasks = [
    done({ title: "a", priority: "high", start: at(8), end: at(9), completedAt: at(8, 30) }),
    done({ title: "b", priority: "high", start: at(9), end: at(10), completedAt: at(11) }),
    makeTask({ title: "c", status: "skipped", priority: "high", start: at(10), end: at(11, 30) }),
    makeTask({ title: "d", start: at(14), end: at(14, 45) }),
    makeTask({ title: "e", start: at(22), end: at(23) }),
  ];
  const t = facts({ tasks }).totals;

  it("counts every outcome and they add up to the total", () => {
    expect(t).toMatchObject({
      total: 5,
      completed: 2,
      completedOnTime: 1,
      completedLate: 1,
      skipped: 1,
      unresolved: 2,
      slipped: 1,
      notYetDue: 1,
      inProgress: 0,
      unscheduled: 0,
    });
    expect(t.completed + t.skipped + t.unresolved).toBe(t.total);
  });

  it("uses the dashboard's own progress definition: completed / (total − skipped)", () => {
    expect(t.completionRatio).toBeCloseTo(2 / 4);
  });

  it("sums minutes by outcome, with a skipped task excluded from planned time", () => {
    expect(t.plannedMinutes).toBe(60 + 60 + 45 + 60);
    expect(t.completedMinutes).toBe(120);
    expect(t.skippedMinutes).toBe(90);
    expect(t.unresolvedMinutes).toBe(105);
  });

  it("counts high-priority work separately", () => {
    expect(t.highPriorityTotal).toBe(3);
    expect(t.highPriorityCompleted).toBe(2);
  });

  it("a day of only skipped tasks has no completion ratio at all (nothing countable)", () => {
    const f = facts({ tasks: [makeTask({ status: "skipped", start: at(9), end: at(10) })] });
    expect(f.totals.completionRatio).toBeNull();
  });
});

describe("computeEodFacts — what moved (history)", () => {
  const task = makeTask({ title: "moved", start: at(15), end: at(16) });

  it("counts recorded window moves and reports the net shift from the ORIGINAL start", () => {
    const f = facts({
      tasks: [task],
      history: [
        history(task.id, {
          event: "rescheduled",
          previousStart: at(10),
          previousEnd: at(11),
          newStart: at(13),
          newEnd: at(14),
          changedAt: at(9, 30),
        }),
        history(task.id, {
          event: "replanned",
          previousStart: at(13),
          previousEnd: at(14),
          newStart: at(15),
          newEnd: at(16),
          changedAt: at(12),
        }),
      ],
    });
    expect(f.tasks[0]).toMatchObject({ rescheduleCount: 2, netShiftMinutes: 5 * 60 });
    expect(f.totals).toMatchObject({ rescheduledTasks: 1, totalReschedules: 2 });
  });

  it("uses the EARLIEST recorded previous start even if rows arrive out of order", () => {
    const rows = [
      history(task.id, {
        event: "replanned",
        previousStart: at(13),
        previousEnd: at(14),
        newStart: at(15),
        newEnd: at(16),
        changedAt: at(12),
      }),
      history(task.id, {
        event: "rescheduled",
        previousStart: at(10),
        previousEnd: at(11),
        newStart: at(13),
        newEnd: at(14),
        changedAt: at(9, 30),
      }),
    ];
    expect(facts({ tasks: [task], history: rows }).tasks[0]!.netShiftMinutes).toBe(300);
  });

  it("a task moved away and back has two moves and a net shift of zero", () => {
    const f = facts({
      tasks: [task],
      history: [
        history(task.id, {
          event: "rescheduled",
          previousStart: at(15),
          previousEnd: at(16),
          newStart: at(17),
          newEnd: at(18),
          changedAt: at(9),
        }),
        history(task.id, {
          event: "rescheduled",
          previousStart: at(17),
          previousEnd: at(18),
          newStart: at(15),
          newEnd: at(16),
          changedAt: at(10),
        }),
      ],
    });
    expect(f.tasks[0]).toMatchObject({ rescheduleCount: 2, netShiftMinutes: 0 });
  });

  it("a replan row that only flipped the unscheduled flag (same window) moved nothing", () => {
    const f = facts({
      tasks: [task],
      history: [
        history(task.id, {
          event: "replanned",
          previousStart: at(15),
          previousEnd: at(16),
          newStart: at(15),
          newEnd: at(16),
        }),
      ],
    });
    expect(f.tasks[0]).toMatchObject({ rescheduleCount: 0, netShiftMinutes: null });
  });

  it("ignores created/status_changed rows and history that belongs to a different task", () => {
    const other = makeTask({ title: "other", start: at(18), end: at(19) });
    const f = facts({
      tasks: [task],
      history: [
        history(task.id, { event: "created" }),
        history(task.id, { event: "status_changed", newStatus: "completed" }),
        history(other.id, {
          event: "rescheduled",
          previousStart: at(1),
          previousEnd: at(2),
          newStart: at(3),
          newEnd: at(4),
        }),
      ],
    });
    expect(f.tasks[0]).toMatchObject({ rescheduleCount: 0, netShiftMinutes: null });
  });

  it("counts plan revisions beyond the first (the initial plan is not a change)", () => {
    expect(facts({ tasks: [task], revisions: [{ revisionNumber: 1 }] }).totals.planRevisions).toBe(
      0,
    );
    expect(
      facts({
        tasks: [task],
        revisions: [1, 2, 3, 4].map((revisionNumber) => ({ revisionNumber })),
      }).totals.planRevisions,
    ).toBe(3);
    expect(facts({ tasks: [task], revisions: [] }).totals.planRevisions).toBe(0);
  });
});

describe("computeEodFacts — aliases, time and privacy", () => {
  it("aliases tasks t1, t2, … in start order, never by database id", () => {
    const later = makeTask({ title: "later", start: at(18), end: at(19) });
    const earlier = makeTask({ title: "earlier", start: at(8), end: at(9) });
    expect(facts({ tasks: [later, earlier] }).tasks.map((t) => [t.ref, t.title])).toEqual([
      ["t1", "earlier"],
      ["t2", "later"],
    ]);
  });

  it("expresses every time as local wall-clock in the DAY's own timezone", () => {
    // 2026-10-01 in Calcutta (UTC+5:30): 21:00 UTC is 02:30 the NEXT local day.
    const f = computeEodFacts({
      planningDate: "2026-10-01",
      timezone: "Asia/Calcutta",
      now: at(21),
      tasks: [done({ start: at(4), end: at(5), completedAt: at(5, 10) })],
      history: [],
      revisions: [],
    });
    expect(f.timezone).toBe("Asia/Calcutta");
    expect(f.asOf).toBe("2026-10-02T02:30");
    expect(f.tasks[0]).toMatchObject({
      start: "2026-10-01T09:30",
      end: "2026-10-01T10:30",
      completedAt: "2026-10-01T10:40",
    });
  });

  it("keeps a task that starts today and ends after midnight on TODAY, ending next day", () => {
    const f = facts({
      tasks: [makeTask({ title: "late night", start: at(23), end: at(1, 0, 1) })],
      now: at(23, 30),
    });
    expect(f.tasks[0]).toMatchObject({
      outcome: "in_progress",
      start: "2026-10-01T23:00",
      end: "2026-10-02T01:00",
      durationMinutes: 120,
    });
  });

  it("an empty day has no tasks and all-zero totals", () => {
    const f = facts();
    expect(f.tasks).toEqual([]);
    expect(f.totals).toMatchObject({
      total: 0,
      completed: 0,
      unresolved: 0,
      completionRatio: null,
    });
  });

  it("contains no task id, no notes, and no user identity anywhere in the facts", () => {
    const tasks = [done({ title: "Quarterly taxes" }), makeTask({ start: at(14), end: at(15) })];
    const json = JSON.stringify(facts({ tasks }));
    for (const t of tasks) {
      expect(json).not.toContain(t.id);
      expect(json).not.toContain(t.userId);
      expect(json).not.toContain(t.dayId);
    }
    expect(json).not.toContain("PRIVATE-NOTES-DO-NOT-LEAK");
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

describe("eodStateCanonical (the staleness fingerprint input)", () => {
  const a = makeTask({ title: "a", start: at(9), end: at(10) });
  const b = makeTask({ title: "b", start: at(11), end: at(12) });

  it("does not depend on the order tasks arrive in", () => {
    expect(eodStateCanonical([a, b])).toBe(eodStateCanonical([b, a]));
  });

  it("changes when a task's status, window, unscheduled flag or completion changes", () => {
    const base = eodStateCanonical([a, b]);
    expect(eodStateCanonical([{ ...a, status: "skipped" }, b])).not.toBe(base);
    expect(eodStateCanonical([{ ...a, status: "completed", completedAt: at(9, 30) }, b])).not.toBe(
      base,
    );
    expect(eodStateCanonical([{ ...a, scheduledStart: at(9, 5) }, b])).not.toBe(base);
    expect(eodStateCanonical([{ ...a, scheduledEnd: at(10, 5) }, b])).not.toBe(base);
    expect(eodStateCanonical([{ ...a, unscheduled: true }, b])).not.toBe(base);
  });

  it("changes when a task is added or removed", () => {
    expect(eodStateCanonical([a])).not.toBe(eodStateCanonical([a, b]));
  });

  it("does NOT change with anything that isn't persisted task state — the clock, titles' derived outcome", () => {
    // Nothing time-dependent is an input at all; assert the contract by construction.
    expect(eodStateCanonical([a, b])).toBe(eodStateCanonical([{ ...a, updatedAt: at(20) }, b]));
  });
});
