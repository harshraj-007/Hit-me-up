import { describe, expect, it } from "vitest";
import { at, buildFor, makeTask } from "../../../tests/support/ai-planning-fixtures";
import { validateProposal, parsedFromProposal } from "./validate-proposal";
import { toConfirmationChanges } from "./confirmation";
import type { PlanProposal } from "./types";

describe("toConfirmationChanges", () => {
  it("carries ref, taskId and newStart for a move, and nothing else", () => {
    const gym = makeTask({ title: "Gym", start: at(17), end: at(18) });
    const { state } = buildFor([gym]);
    const proposal: PlanProposal = {
      understood: "ok",
      changes: [{ kind: "move", ref: "t1", newStart: "2026-10-01T20:00", reason: "r" }],
      unresolved: [],
    };
    const result = validateProposal({ state, parsed: parsedFromProposal(proposal) });
    const changes = toConfirmationChanges(result.accepted);
    expect(changes).toEqual([{ kind: "move", ref: "t1", taskId: gym.id, newStart: at(20) }]);
    expect(Object.keys(changes[0]!).sort()).toEqual(["kind", "newStart", "ref", "taskId"]);
  });

  it("carries ref and taskId for an unschedule, and no time field", () => {
    const gym = makeTask({ title: "Gym", start: at(17), end: at(18) });
    const { state } = buildFor([gym]);
    const proposal: PlanProposal = {
      understood: "ok",
      changes: [{ kind: "unschedule", ref: "t1", reason: "r" }],
      unresolved: [],
    };
    const result = validateProposal({ state, parsed: parsedFromProposal(proposal) });
    const changes = toConfirmationChanges(result.accepted);
    expect(changes).toEqual([{ kind: "unschedule", ref: "t1", taskId: gym.id }]);
    expect(Object.keys(changes[0]!).sort()).toEqual(["kind", "ref", "taskId"]);
  });

  it("is order-preserving and length-preserving for several changes", () => {
    const a = makeTask({ title: "A", start: at(10), end: at(11) });
    const b = makeTask({ title: "B", start: at(12), end: at(13) });
    const { state, context } = buildFor([a, b]);
    const refA = context.tasks.find((t) => t.title === "A")!.ref;
    const refB = context.tasks.find((t) => t.title === "B")!.ref;
    const proposal: PlanProposal = {
      understood: "ok",
      changes: [
        { kind: "move", ref: refA, newStart: "2026-10-01T15:00", reason: "r" },
        { kind: "unschedule", ref: refB, reason: "r" },
      ],
      unresolved: [],
    };
    const result = validateProposal({ state, parsed: parsedFromProposal(proposal) });
    expect(result.status).toBe("valid");
    const changes = toConfirmationChanges(result.accepted);
    expect(changes.map((c) => c.ref)).toEqual([refA, refB]);
    expect(changes.map((c) => c.kind)).toEqual(["move", "unschedule"]);
  });

  it("produces nothing for an empty accepted list", () => {
    expect(toConfirmationChanges([])).toEqual([]);
  });
});
