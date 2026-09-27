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
vi.mock("./day", () => ({ viewDay: vi.fn() }));

import { revalidatePath } from "next/cache";
import { requireUserForAction } from "@/server/auth/session";
import {
  confirmAiProposal as confirmAiProposalRpc,
  listTasksForDay,
} from "@/server/db/repositories/tasks";
import { z } from "zod";
import { AiConfirmationError, AuthenticationError, ValidationError } from "@/server/errors";
import type { Task } from "@/domain/tasks";
import { viewDay } from "./day";
import { confirmAiProposal } from "./ai-confirmation";

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
