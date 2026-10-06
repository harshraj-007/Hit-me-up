import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ requireUserForAction: vi.fn() }));
vi.mock("@/server/db/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({})),
}));
vi.mock("@/server/db/repositories/tasks", () => ({
  confirmAiProposal: vi.fn(),
  listTasksForDay: vi.fn(),
}));
vi.mock("@/server/db/repositories/ai-proposals", () => ({
  confirmAiProposalById: vi.fn(),
  discardAiProposal: vi.fn(),
  getAiProposalById: vi.fn(),
}));
vi.mock("./day", () => ({ viewDay: vi.fn() }));

import { revalidatePath } from "next/cache";
import { requireUserForAction } from "@/server/auth/session";
import {
  confirmAiProposal as confirmAiProposalRpc,
  listTasksForDay,
} from "@/server/db/repositories/tasks";
import {
  confirmAiProposalById,
  discardAiProposal as discardAiProposalRpc,
  getAiProposalById,
} from "@/server/db/repositories/ai-proposals";
import { z } from "zod";
import { AiConfirmationError, AuthenticationError, ValidationError } from "@/server/errors";
import type { Task } from "@/domain/tasks";
import { viewDay } from "./day";
import {
  confirmAiProposal,
  confirmPersistedAiProposal,
  discardPersistedAiProposal,
} from "./ai-confirmation";

const DAY = { id: "day-1", userId: "user-1", localDate: "2026-10-01", timezone: "UTC" };
const UUID = "0b7e3c1e-5a52-4b6c-9d0f-2f1a4f5e6a77";

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    userId: "user-1",
    dayId: "day-1",
    title: "Gym",
    notes: null,
    status: "upcoming",
    priority: "medium",
    kind: "flexible",
    source: "user",
    scheduledStart: new Date("2026-10-01T20:00:00.000Z"),
    scheduledEnd: new Date("2026-10-01T21:00:00.000Z"),
    dueAt: null,
    completedAt: null,
    scheduleLocked: true,
    unscheduled: false,
    createdAt: new Date("2026-09-30T08:00:00.000Z"),
    updatedAt: new Date("2026-10-01T20:00:00.000Z"),
    ...over,
  };
}

const request = (over: Record<string, unknown> = {}) => ({
  planningDate: "2026-10-01",
  baseRevision: 3,
  changes: [{ ref: "t1", taskId: UUID, type: "move", newStart: "2026-10-01T20:00:00.000Z" }],
  ...over,
});

beforeEach(() => {
  vi.mocked(requireUserForAction).mockResolvedValue({ id: "user-1", email: null });
  vi.mocked(viewDay).mockResolvedValue(DAY);
  vi.mocked(confirmAiProposalRpc).mockResolvedValue(4);
  vi.mocked(listTasksForDay).mockResolvedValue([makeTask()]);
});
afterEach(() => vi.restoreAllMocks());

describe("confirmAiProposal", () => {
  it("requires authentication before doing anything else", async () => {
    vi.mocked(requireUserForAction).mockRejectedValue(new AuthenticationError());
    await expect(confirmAiProposal(request())).rejects.toBeInstanceOf(AuthenticationError);
    expect(viewDay).not.toHaveBeenCalled();
    expect(confirmAiProposalRpc).not.toHaveBeenCalled();
  });

  it("rejects malformed input via the Zod schema, before ever resolving a day or calling the RPC", async () => {
    // Matches the rest of the app's convention (e.g. createTaskForDay): the service calls
    // `.parse()` directly, so a shape failure surfaces as a ZodError here and is normalized to
    // a ValidationError only at the runAction/route boundary (see src/server/errors/normalize.ts).
    for (const bad of [
      request({ planningDate: "not-a-date" }),
      request({ baseRevision: -1 }),
      request({ changes: [] }),
      request({ changes: [{ ref: "t1", taskId: UUID, type: "move" }] }), // missing newStart
      request({ userId: "someone-else" }),
      request({ changes: [{ ...request().changes[0], newEnd: "2026-10-01T22:00:00.000Z" }] }),
    ]) {
      await expect(confirmAiProposal(bad)).rejects.toBeInstanceOf(z.ZodError);
    }
    expect(viewDay).not.toHaveBeenCalled();
    expect(confirmAiProposalRpc).not.toHaveBeenCalled();
  });

  it("never accepts a client-supplied day id — only a planning date it resolves itself", async () => {
    await confirmAiProposal(request());
    expect(viewDay).toHaveBeenCalledWith(expect.anything(), "user-1", "2026-10-01");
  });

  it("treats a day with no plan as 'nothing to confirm', not a task-level decision", async () => {
    vi.mocked(viewDay).mockResolvedValue(null);
    await expect(confirmAiProposal(request())).rejects.toBeInstanceOf(ValidationError);
    expect(confirmAiProposalRpc).not.toHaveBeenCalled();
  });

  it("passes the resolved day id, base revision, and mapped changes to the RPC — never the ValidationResult", async () => {
    await confirmAiProposal(
      request({
        changes: [
          { ref: "t1", taskId: UUID, type: "move", newStart: "2026-10-01T20:00:00.000Z" },
          { ref: "t2", taskId: "9f0c3a1e-5a52-4b6c-9d0f-2f1a4f5e6a77", type: "unschedule" },
        ],
      }),
    );
    expect(confirmAiProposalRpc).toHaveBeenCalledWith(expect.anything(), "day-1", 3, [
      { kind: "move", ref: "t1", taskId: UUID, newStart: new Date("2026-10-01T20:00:00.000Z") },
      { kind: "unschedule", ref: "t2", taskId: "9f0c3a1e-5a52-4b6c-9d0f-2f1a4f5e6a77" },
    ]);
  });

  it("re-reads the day's tasks after a successful confirmation and returns the new revision", async () => {
    const fresh = [makeTask({ id: "task-9" })];
    vi.mocked(listTasksForDay).mockResolvedValue(fresh);
    const result = await confirmAiProposal(request());
    expect(listTasksForDay).toHaveBeenCalledWith(expect.anything(), "day-1");
    expect(result).toEqual({ revisionNumber: 4, tasks: fresh });
  });

  it("revalidates the Today page after a successful confirmation", async () => {
    await confirmAiProposal(request());
    expect(revalidatePath).toHaveBeenCalledWith("/today");
  });

  it("propagates the RPC's AiConfirmationError untouched, and re-reads nothing on failure", async () => {
    vi.mocked(confirmAiProposalRpc).mockRejectedValue(new AiConfirmationError("stale_revision"));
    await expect(confirmAiProposal(request())).rejects.toBeInstanceOf(AiConfirmationError);
    expect(listTasksForDay).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["stale_revision", "task_ineligible", "conflict", "invalid_proposal"] as const)(
    "surfaces AiConfirmationError(%s) with its reason intact",
    async (reason) => {
      vi.mocked(confirmAiProposalRpc).mockRejectedValue(new AiConfirmationError(reason));
      const error = await confirmAiProposal(request()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(AiConfirmationError);
      expect((error as AiConfirmationError).reason).toBe(reason);
    },
  );
});

// Phase 5.5: the app's ACTUAL confirmation path — a persisted proposal, confirmed by id.
// `confirmAiProposal` above (the raw day/revision/changes shape) is kept as a lower-level
// primitive but is no longer reachable from any Server Action; see actions.ts.
const PROPOSAL = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  dayId: "day-1",
  baseRevision: 3,
  source: "voice" as const,
  transcriptText: "move gym to 8pm",
  understood: "Move gym to 8pm.",
  unresolved: [],
  changes: [
    { ref: "t1", task_id: UUID, type: "move" as const, new_start: "2026-10-01T20:00:00.000Z" },
  ],
  rejected: [],
  conflictsAfter: [],
  validationStatus: "valid" as const,
  status: "generated" as const,
  createdAt: new Date("2026-10-01T09:00:00.000Z"),
  confirmedAt: null,
  appliedRevisionNumber: null,
  briefingId: null,
};

describe("confirmPersistedAiProposal (Phase 5.5, the app's real confirmation path)", () => {
  beforeEach(() => {
    vi.mocked(getAiProposalById).mockResolvedValue(PROPOSAL);
    vi.mocked(confirmAiProposalById).mockResolvedValue(5);
  });

  it("requires authentication before doing anything else", async () => {
    vi.mocked(requireUserForAction).mockRejectedValue(new AuthenticationError());
    await expect(confirmPersistedAiProposal({ proposalId: PROPOSAL.id })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(getAiProposalById).not.toHaveBeenCalled();
    expect(confirmAiProposalById).not.toHaveBeenCalled();
  });

  it("accepts ONLY a proposal id — no day, revision, or change can be supplied at all", async () => {
    for (const bad of [
      { proposalId: PROPOSAL.id, baseRevision: 999 },
      { proposalId: PROPOSAL.id, dayId: "someone-elses-day" },
      {
        proposalId: PROPOSAL.id,
        changes: [{ ref: "t1", taskId: UUID, type: "move", newStart: "x" }],
      },
      { proposalId: PROPOSAL.id, planningDate: "2026-10-01" },
      { proposalId: "not-a-uuid" },
      {},
    ]) {
      await expect(confirmPersistedAiProposal(bad)).rejects.toBeInstanceOf(z.ZodError);
    }
    expect(confirmAiProposalById).not.toHaveBeenCalled();
  });

  it("passes ONLY the proposal id to the RPC — the day/revision/changes it confirms against come from the stored row, not this call", async () => {
    await confirmPersistedAiProposal({ proposalId: PROPOSAL.id });
    expect(confirmAiProposalById).toHaveBeenCalledWith(expect.anything(), PROPOSAL.id);
    expect(confirmAiProposalById).toHaveBeenCalledTimes(1);
  });

  it("a missing/foreign proposal id is refused before ever calling the RPC", async () => {
    vi.mocked(getAiProposalById).mockResolvedValue(null);
    const error = await confirmPersistedAiProposal({ proposalId: PROPOSAL.id }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AiConfirmationError);
    expect((error as AiConfirmationError).reason).toBe("proposal_unavailable");
    expect(confirmAiProposalById).not.toHaveBeenCalled();
  });

  it("re-reads the day's tasks (the proposal's OWN dayId, not any client input) after success", async () => {
    const fresh = [makeTask({ id: "task-9" })];
    vi.mocked(listTasksForDay).mockResolvedValue(fresh);
    const result = await confirmPersistedAiProposal({ proposalId: PROPOSAL.id });
    expect(listTasksForDay).toHaveBeenCalledWith(expect.anything(), PROPOSAL.dayId);
    expect(result).toEqual({ revisionNumber: 5, tasks: fresh });
  });

  it("revalidates the Today page after a successful confirmation", async () => {
    await confirmPersistedAiProposal({ proposalId: PROPOSAL.id });
    expect(revalidatePath).toHaveBeenCalledWith("/today");
  });

  it("propagates the RPC's AiConfirmationError untouched, and re-reads nothing on failure", async () => {
    vi.mocked(confirmAiProposalById).mockRejectedValue(new AiConfirmationError("stale_revision"));
    await expect(confirmPersistedAiProposal({ proposalId: PROPOSAL.id })).rejects.toBeInstanceOf(
      AiConfirmationError,
    );
    expect(listTasksForDay).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    "stale_revision",
    "task_ineligible",
    "proposal_unavailable",
    "conflict",
    "invalid_proposal",
  ] as const)("surfaces AiConfirmationError(%s) with its reason intact", async (reason) => {
    vi.mocked(confirmAiProposalById).mockRejectedValue(new AiConfirmationError(reason));
    const error = await confirmPersistedAiProposal({ proposalId: PROPOSAL.id }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AiConfirmationError);
    expect((error as AiConfirmationError).reason).toBe(reason);
  });

  it("this is a genuinely separate, replay-safe path from the raw confirmAiProposal above — it never calls the old RPC directly", async () => {
    await confirmPersistedAiProposal({ proposalId: PROPOSAL.id });
    expect(confirmAiProposalRpc).not.toHaveBeenCalled();
  });
});

describe("discardPersistedAiProposal (Phase 5.5)", () => {
  it("requires authentication", async () => {
    vi.mocked(requireUserForAction).mockRejectedValue(new AuthenticationError());
    await expect(discardPersistedAiProposal({ proposalId: PROPOSAL.id })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(discardAiProposalRpc).not.toHaveBeenCalled();
  });

  it("accepts only a proposal id", async () => {
    for (const bad of [
      {},
      { proposalId: "not-a-uuid" },
      { proposalId: PROPOSAL.id, status: "confirmed" },
    ]) {
      await expect(discardPersistedAiProposal(bad)).rejects.toBeInstanceOf(z.ZodError);
    }
    expect(discardAiProposalRpc).not.toHaveBeenCalled();
  });

  it("calls the RPC with the id and revalidates — no read of the proposal or the tasks is needed", async () => {
    await discardPersistedAiProposal({ proposalId: PROPOSAL.id });
    expect(discardAiProposalRpc).toHaveBeenCalledWith(expect.anything(), PROPOSAL.id);
    expect(revalidatePath).toHaveBeenCalledWith("/today");
    expect(getAiProposalById).not.toHaveBeenCalled();
    expect(listTasksForDay).not.toHaveBeenCalled();
  });

  it("propagates a database failure", async () => {
    vi.mocked(discardAiProposalRpc).mockRejectedValue(new Error("db down"));
    await expect(discardPersistedAiProposal({ proposalId: PROPOSAL.id })).rejects.toThrow(
      "db down",
    );
  });
});
