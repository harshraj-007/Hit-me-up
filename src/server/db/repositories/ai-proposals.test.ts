import { describe, expect, it, vi } from "vitest";
import { AiConfirmationError, ExternalServiceError } from "@/server/errors";
import type { ValidationResult } from "@/domain/ai-planning";
import {
  createAiProposal,
  confirmAiProposalById,
  discardAiProposal,
  findPendingProposal,
  getAiProposalById,
} from "./ai-proposals";

const ROW = {
  id: "p1",
  user_id: "u1",
  day_id: "d1",
  base_revision: 3,
  source: "voice",
  transcript_text: "move gym to 8pm",
  understood: "Move gym to 8pm.",
  unresolved: ["extra hour for the assignment"],
  changes: [
    {
      ref: "t1",
      task_id: "11111111-1111-4111-8111-111111111111",
      type: "move",
      new_start: "2026-10-01T20:00:00.000Z",
    },
  ],
  rejected: [{ code: "locked_task", message: "Locked.", changeIndex: 1, ref: "t2" }],
  conflicts_after: [
    {
      firstTaskId: "11111111-1111-4111-8111-111111111111",
      secondTaskId: "33333333-3333-4333-8333-333333333333",
      firstRef: "t1",
      secondRef: "t3",
      involvesProposal: true,
    },
  ],
  validation_status: "valid",
  status: "generated",
  created_at: "2026-10-01T09:00:00.000Z",
  confirmed_at: null,
  applied_revision_number: null,
};

function fakeFrom(result: { data: unknown; error: unknown }, seen: string[] = []) {
  return {
    from(table: string) {
      seen.push(`from:${table}`);
      const chain = {
        select: () => chain,
        eq: (c: string, v: string) => {
          seen.push(`eq:${c}=${v}`);
          return chain;
        },
        maybeSingle: async () => result,
      };
      return chain;
    },
  } as never;
}
function fakeRpc(result: { data: unknown; error: unknown }) {
  return { rpc: vi.fn(async () => result) } as never;
}

describe("mapProposal (read boundary, exercised via findPendingProposal/getAiProposalById)", () => {
  it("maps a well-formed row, including Date conversions", async () => {
    const proposal = await getAiProposalById(fakeFrom({ data: ROW, error: null }), "p1");
    expect(proposal).toEqual({
      id: "p1",
      dayId: "d1",
      baseRevision: 3,
      source: "voice",
      transcriptText: "move gym to 8pm",
      understood: "Move gym to 8pm.",
      unresolved: ["extra hour for the assignment"],
      changes: [
        {
          ref: "t1",
          task_id: "11111111-1111-4111-8111-111111111111",
          type: "move",
          new_start: "2026-10-01T20:00:00.000Z",
        },
      ],
      rejected: [{ code: "locked_task", message: "Locked.", changeIndex: 1, ref: "t2" }],
      conflictsAfter: [
        {
          firstTaskId: "11111111-1111-4111-8111-111111111111",
          secondTaskId: "33333333-3333-4333-8333-333333333333",
          firstRef: "t1",
          secondRef: "t3",
          involvesProposal: true,
        },
      ],
      validationStatus: "valid",
      status: "generated",
      createdAt: new Date("2026-10-01T09:00:00.000Z"),
      confirmedAt: null,
      appliedRevisionNumber: null,
    });
  });

  it("null when the row doesn't exist (RLS-hidden or genuinely missing — indistinguishable)", async () => {
    expect(await getAiProposalById(fakeFrom({ data: null, error: null }), "p1")).toBeNull();
    expect(await findPendingProposal(fakeFrom({ data: null, error: null }), "d1")).toBeNull();
  });

  it("rejects a row whose stored changes/rejected/conflicts_after don't match the expected shape, rather than trusting it", async () => {
    for (const bad of [
      {
        ...ROW,
        changes: [
          {
            ref: "not-alias-shaped",
            task_id: "11111111-1111-4111-8111-111111111111",
            type: "move",
            new_start: "x",
          },
        ],
      },
      { ...ROW, changes: [{ ref: "t1", task_id: "not-a-uuid", type: "move", new_start: "x" }] },
      {
        ...ROW,
        changes: [{ ref: "t1", task_id: "11111111-1111-4111-8111-111111111111", type: "move" }],
      }, // missing new_start
      { ...ROW, changes: "not-an-array" },
      { ...ROW, rejected: [{ code: "made_up_code", message: "x", changeIndex: 0, ref: null }] },
      { ...ROW, conflicts_after: [{ firstTaskId: "not-a-uuid" }] },
      { ...ROW, unresolved: "not-an-array" },
    ]) {
      await expect(getAiProposalById(fakeFrom({ data: bad, error: null }), "p1")).rejects.toThrow();
    }
  });

  it("findPendingProposal queries only by day_id and status=generated", async () => {
    const seen: string[] = [];
    await findPendingProposal(fakeFrom({ data: ROW, error: null }, seen), "d1");
    expect(seen).toEqual(["from:ai_proposals", "eq:day_id=d1", "eq:status=generated"]);
  });

  it("getAiProposalById queries only by id", async () => {
    const seen: string[] = [];
    await getAiProposalById(fakeFrom({ data: ROW, error: null }, seen), "p1");
    expect(seen).toEqual(["from:ai_proposals", "eq:id=p1"]);
  });

  it("wraps a database read failure without leaking it", async () => {
    const failing = fakeFrom({ data: null, error: { code: "XX000", message: "secret" } });
    await expect(getAiProposalById(failing, "p1")).rejects.toBeInstanceOf(ExternalServiceError);
    await expect(findPendingProposal(failing, "d1")).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

const VALIDATION: ValidationResult = {
  status: "valid",
  baseRevision: 3,
  accepted: [
    {
      changeIndex: 0,
      ref: "t1",
      taskId: "11111111-1111-4111-8111-111111111111",
      dayId: "d1",
      reason: "x",
      kind: "move",
      previousStart: new Date("2026-10-01T17:00:00Z"),
      previousEnd: new Date("2026-10-01T18:00:00Z"),
      previousUnscheduled: false,
      newStart: new Date("2026-10-01T20:00:00Z"),
      newEnd: new Date("2026-10-01T21:00:00Z"),
    },
  ],
  rejected: [{ code: "locked_task", message: "Locked.", changeIndex: 1, ref: "t2" }],
  conflictsAfter: [],
};

describe("createAiProposal", () => {
  it("sends the confirm wire shape for `changes` (never `reason`/`previousStart`), and the raw rejected/conflictsAfter for display", async () => {
    const rpc = vi.fn(async () => ({ data: ROW, error: null }));
    const supabase = { rpc } as never;
    await createAiProposal(supabase, {
      dayId: "d1",
      source: "voice",
      transcriptText: "move gym",
      understood: "ok",
      unresolved: ["x"],
      validation: VALIDATION,
    });
    expect(rpc).toHaveBeenCalledWith("create_ai_proposal", {
      p_day_id: "d1",
      p_base_revision: 3,
      p_source: "voice",
      p_transcript_text: "move gym",
      p_understood: "ok",
      p_unresolved: ["x"],
      p_changes: [
        {
          ref: "t1",
          task_id: "11111111-1111-4111-8111-111111111111",
          type: "move",
          new_start: "2026-10-01T20:00:00.000Z",
        },
      ],
      p_rejected: VALIDATION.rejected,
      p_conflicts_after: VALIDATION.conflictsAfter,
      p_validation_status: "valid",
    });
  });

  it("sends an empty changes array when nothing was accepted (invalid/partially_valid persist too)", async () => {
    const rpc = vi.fn(async () => ({ data: ROW, error: null }));
    const supabase = { rpc } as never;
    await createAiProposal(supabase, {
      dayId: "d1",
      source: "typed",
      transcriptText: "x",
      understood: "ok",
      unresolved: [],
      validation: { ...VALIDATION, status: "invalid", accepted: [] },
    });
    expect(rpc).toHaveBeenCalledWith(
      "create_ai_proposal",
      expect.objectContaining({ p_changes: [], p_validation_status: "invalid" }),
    );
  });

  it("wraps a database failure, without a special message for a generic error", async () => {
    await expect(
      createAiProposal(
        { rpc: vi.fn(async () => ({ data: null, error: { code: "XX000" } })) } as never,
        {
          dayId: "d1",
          source: "typed",
          transcriptText: "x",
          understood: "x",
          unresolved: [],
          validation: VALIDATION,
        },
      ),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

describe("confirmAiProposalById", () => {
  it("calls the RPC with only the proposal id, and returns the new revision", async () => {
    const rpc = vi.fn(async () => ({ data: 4, error: null }));
    await expect(confirmAiProposalById({ rpc } as never, "p1")).resolves.toBe(4);
    expect(rpc).toHaveBeenCalledWith("confirm_ai_proposal_by_id", { p_proposal_id: "p1" });
  });

  it.each([
    ["40001", "stale_revision"],
    ["P0002", "proposal_unavailable"],
    ["23P01", "conflict"],
    ["22023", "invalid_proposal"],
  ] as const)("maps SQLSTATE %s to AiConfirmationError(%s)", async (code, reason) => {
    const error = await confirmAiProposalById(fakeRpc({ data: null, error: { code } }), "p1").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AiConfirmationError);
    expect((error as AiConfirmationError).reason).toBe(reason);
  });

  it("wraps an unrecognized error", async () => {
    await expect(
      confirmAiProposalById(fakeRpc({ data: null, error: { code: "XX000" } }), "p1"),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

describe("discardAiProposal", () => {
  it("calls the RPC with only the proposal id", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    await discardAiProposal({ rpc } as never, "p1");
    expect(rpc).toHaveBeenCalledWith("discard_ai_proposal", { p_proposal_id: "p1" });
  });

  it("wraps a database failure", async () => {
    await expect(
      discardAiProposal(fakeRpc({ data: null, error: { code: "XX000" } }), "p1"),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });
});
