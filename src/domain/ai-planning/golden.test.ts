import { describe, expect, it } from "vitest";
import { at, buildFor, makeTask, PLANNING_DATE } from "../../../tests/support/ai-planning-fixtures";
import { parseRawProposal, parseUserIntent } from "@/lib/validation/ai-planning";
import { validateProposal } from "./validate-proposal";

const REQUEST =
  "I have an assignment that came up, so give me an extra hour for it. Move my gym to after 8, don't move my DSA session, and I need to leave by 10.";

/**
 * The eventual product path, with the AI layer stood in for by a hand-written RawProposal:
 *   raw text → UserIntent → (future AI) → RawProposal → deterministic validation.
 */
describe("golden scenario: assignment / gym / DSA / leave by 10", () => {
  const gym = makeTask({ title: "Gym", start: at(17), end: at(18) });
  const dsa = makeTask({
    title: "DSA session",
    start: at(18),
    end: at(19, 30),
    scheduleLocked: true,
  });
  const assignment = makeTask({ title: "Assignment", start: at(19, 30), end: at(20) });
  const { state, context } = buildFor([gym, dsa, assignment]);
  const ref = (title: string) => context.tasks.find((t) => t.title === title)!.ref;

  it("the request becomes an opaque UserIntent", () => {
    const parsed = parseUserIntent(
      {
        id: "0b7e3c1e-5a52-4b6c-9d0f-2f1a4f5e6a77",
        source: "voice",
        text: `  ${REQUEST}  `,
        planningDate: PLANNING_DATE,
      },
      { submittedAt: new Date("2026-10-01T09:00:00Z"), todayLocal: PLANNING_DATE },
    );
    expect(parsed.ok && parsed.intent.text).toBe(REQUEST);
    expect(parsed.ok && parsed.intent.source).toBe("voice");
  });

  it("moves the gym, keeps DSA where it is, and refuses the duration change", () => {
    const raw = {
      understood: "Move gym after 8pm, keep DSA, and give the assignment an extra hour.",
      changes: [
        {
          kind: "move",
          ref: ref("Gym"),
          newStart: "2026-10-01T20:00",
          reason: "You asked for gym after 8.",
        },
        {
          kind: "change_duration",
          ref: ref("Assignment"),
          newDurationMinutes: 90,
          reason: "Extra hour.",
        },
      ],
      unresolved: ["Leave by 10pm — no way to express this yet."],
    };
    const parsed = parseRawProposal(raw);
    if (!parsed.ok) throw new Error("should parse");
    const result = validateProposal({ state, parsed });

    expect(result.status).toBe("partially_valid");
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({
      kind: "move",
      taskId: gym.id,
      newStart: at(20),
      newEnd: at(21),
    });
    expect(result.rejected.map((r) => [r.changeIndex, r.code])).toEqual([
      [1, "unsupported_change"],
    ]);
    // DSA and the assignment are untouched: nothing accepted names them, durations intact.
    expect(result.accepted.some((a) => a.taskId === dsa.id || a.taskId === assignment.id)).toBe(
      false,
    );
    expect(result.conflictsAfter).toEqual([]);
  });

  it("if the model tries to move DSA anyway, the lock wins", () => {
    const parsed = parseRawProposal({
      understood: "x",
      changes: [
        { kind: "move", ref: ref("DSA session"), newStart: "2026-10-01T21:00", reason: "x" },
      ],
      unresolved: [],
    });
    if (!parsed.ok) throw new Error("should parse");
    const result = validateProposal({ state, parsed });
    expect(result.status).toBe("invalid");
    expect(result.rejected.map((r) => r.code)).toEqual(["locked_task"]);
  });

  it("the gym move alone is fully valid", () => {
    const parsed = parseRawProposal({
      understood: "x",
      changes: [{ kind: "move", ref: ref("Gym"), newStart: "2026-10-01T20:00", reason: "x" }],
      unresolved: ["Extra hour for the assignment"],
    });
    if (!parsed.ok) throw new Error("should parse");
    expect(validateProposal({ state, parsed }).status).toBe("valid");
  });
});
