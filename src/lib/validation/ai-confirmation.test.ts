import { describe, expect, it } from "vitest";
import { confirmAiProposalInputSchema } from "./ai-confirmation";

const UUID_1 = "0b7e3c1e-5a52-4b6c-9d0f-2f1a4f5e6a77";
const UUID_2 = "9f0c3a1e-5a52-4b6c-9d0f-2f1a4f5e6a77";
const move = (ref: string, taskId: string, newStart = "2026-10-01T20:00:00.000Z") => ({
  ref,
  taskId,
  type: "move" as const,
  newStart,
});
const unschedule = (ref: string, taskId: string) => ({ ref, taskId, type: "unschedule" as const });
const input = (changes: unknown[], over: Record<string, unknown> = {}) => ({
  planningDate: "2026-10-01",
  baseRevision: 3,
  changes,
  ...over,
});

describe("confirmAiProposalInputSchema", () => {
  it("accepts a well-formed move and unschedule", () => {
    const r = confirmAiProposalInputSchema.safeParse(
      input([move("t1", UUID_1), unschedule("t2", UUID_2)]),
    );
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.changes[0]).toMatchObject({ ref: "t1", taskId: UUID_1, type: "move" });
      expect(r.data.changes[0]).toHaveProperty("newStart");
      expect(r.data.changes[1]).toEqual({ ref: "t2", taskId: UUID_2, type: "unschedule" });
    }
  });

  it("requires a real planning date, never a day id", () => {
    expect(
      confirmAiProposalInputSchema.safeParse(
        input([move("t1", UUID_1)], { planningDate: "not-a-date" }),
      ).success,
    ).toBe(false);
    expect(confirmAiProposalInputSchema.safeParse(input([move("t1", UUID_1)])).success).toBe(true);
  });

  it("rejects a non-integer or negative base revision", () => {
    expect(
      confirmAiProposalInputSchema.safeParse(input([move("t1", UUID_1)], { baseRevision: 1.5 }))
        .success,
    ).toBe(false);
    expect(
      confirmAiProposalInputSchema.safeParse(input([move("t1", UUID_1)], { baseRevision: -1 }))
        .success,
    ).toBe(false);
    expect(
      confirmAiProposalInputSchema.safeParse(input([move("t1", UUID_1)], { baseRevision: 0 }))
        .success,
    ).toBe(true);
  });

  it("rejects an empty or over-sized change list", () => {
    expect(confirmAiProposalInputSchema.safeParse(input([])).success).toBe(false);
    const uuidN = (n: number) => `0b7e3c1e-5a52-4b6c-9d0f-2f1a4f5e6${String(n).padStart(3, "0")}`;
    const many = Array.from({ length: 21 }, (_, i) => unschedule(`t${i + 1}`, uuidN(i)));
    expect(confirmAiProposalInputSchema.safeParse(input(many)).success).toBe(false);
    expect(confirmAiProposalInputSchema.safeParse(input(many.slice(0, 20))).success).toBe(true);
  });

  it("rejects a malformed ref or a non-uuid taskId", () => {
    expect(confirmAiProposalInputSchema.safeParse(input([move("x1", UUID_1)])).success).toBe(false);
    expect(confirmAiProposalInputSchema.safeParse(input([move("t1", "not-a-uuid")])).success).toBe(
      false,
    );
  });

  it("rejects an unknown change type", () => {
    expect(
      confirmAiProposalInputSchema.safeParse(input([{ ref: "t1", taskId: UUID_1, type: "delete" }]))
        .success,
    ).toBe(false);
  });

  it("rejects a move with no newStart, and an unschedule that carries one", () => {
    expect(
      confirmAiProposalInputSchema.safeParse(input([{ ref: "t1", taskId: UUID_1, type: "move" }]))
        .success,
    ).toBe(false);
    expect(
      confirmAiProposalInputSchema.safeParse(
        input([
          { ref: "t1", taskId: UUID_1, type: "unschedule", newStart: "2026-10-01T20:00:00.000Z" },
        ]),
      ).success,
    ).toBe(false);
  });

  it.each([
    ["a new end time", { newEnd: "2026-10-01T22:00:00.000Z" }],
    ["a duration", { durationMinutes: 90 }],
    ["a force flag", { force: true }],
    ["a locked override", { locked: false }],
    ["a conflict override", { ignoreConflicts: true }],
    ["a task owner", { userId: UUID_2 }],
    ["a task source", { source: "planner" }],
    ["arbitrary SQL", { sql: "drop table tasks" }],
  ])("rejects a move carrying %s", (_label, extra) => {
    expect(
      confirmAiProposalInputSchema.safeParse(input([{ ...move("t1", UUID_1), ...extra }])).success,
    ).toBe(false);
  });

  it("rejects a client-supplied dayId, email, or userId at the top level", () => {
    for (const extra of [{ dayId: UUID_1 }, { email: "a@example.com" }, { userId: UUID_1 }]) {
      expect(
        confirmAiProposalInputSchema.safeParse(input([move("t1", UUID_1)], extra)).success,
      ).toBe(false);
    }
  });

  it("rejects the same task referenced more than once, regardless of change kind", () => {
    expect(
      confirmAiProposalInputSchema.safeParse(input([move("t1", UUID_1), move("t2", UUID_1)]))
        .success,
    ).toBe(false);
    expect(
      confirmAiProposalInputSchema.safeParse(input([move("t1", UUID_1), unschedule("t2", UUID_1)]))
        .success,
    ).toBe(false);
  });

  it("allows the same alias to appear twice as long as the task ids differ (ref is not authoritative)", () => {
    // Unusual, but ref carries no identity here — only taskId does; the RPC re-verifies everything.
    expect(
      confirmAiProposalInputSchema.safeParse(input([move("t1", UUID_1), unschedule("t1", UUID_2)]))
        .success,
    ).toBe(true);
  });
});
