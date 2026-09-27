import "server-only";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { ConfirmationChange } from "@/domain/ai-planning";
import type { Task } from "@/domain/tasks";
import { confirmAiProposalInputSchema } from "@/lib/validation/ai-confirmation";
import { requireUserForAction } from "@/server/auth/session";
import {
  confirmAiProposalById as confirmAiProposalByIdRpc,
  discardAiProposal as discardAiProposalRpc,
  getAiProposalById,
  type AiProposal,
} from "@/server/db/repositories/ai-proposals";
import {
  confirmAiProposal as confirmAiProposalRpc,
  listTasksForDay,
} from "@/server/db/repositories/tasks";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { AiConfirmationError, ValidationError } from "@/server/errors";
import { viewDay } from "./day";

export interface ConfirmAiProposalOutcome {
  revisionNumber: number;
  /** The day's tasks after the confirmation — authoritative, re-read from the database. */
  tasks: Task[];
}

/**
 * Applies a proposal the caller supplies directly as `{planningDate, baseRevision, changes}`.
 * This is the pre-Phase-5.5 confirmation path — still correct, still fully re-validated in SQL,
 * kept as a lower-level primitive — but it is no longer wired to any Server Action: the app's
 * actual confirmation flow is `confirmPersistedAiProposal`, below, which confirms a proposal
 * the server itself already generated and stored, and cannot be handed a different
 * base_revision or changes than what was really generated (see that function's own comment).
 * An unused Server Action is still a reachable endpoint, so Phase 5.5 removed this one's
 * Action wrapper rather than leave a second, weaker way to reach the same mutation.
 *
 * Reaches the database through exactly one call to the SECURITY DEFINER `confirm_ai_proposal`
 * RPC (`server/db/repositories/tasks.ts`) — this function issues no direct table write of its
 * own. The database is the final authority: everything this service does before that call
 * (parsing, resolving the day) is about identifying WHAT the caller is asking to confirm, never
 * about deciding whether it is allowed — ownership, current task eligibility, the base revision
 * and the resulting conflicts are all independently re-verified in SQL, regardless of what a
 * Phase 5.2 `ValidationResult` said earlier.
 */
export async function confirmAiProposal(rawInput: unknown): Promise<ConfirmAiProposalOutcome> {
  const user = await requireUserForAction();
  const input = confirmAiProposalInputSchema.parse(rawInput);

  const supabase = await createSupabaseServerClient();
  const day = await viewDay(supabase, user.id, input.planningDate);
  if (!day) {
    throw new ValidationError([
      { path: "planningDate", message: "There's nothing planned on that day yet." },
    ]);
  }

  const changes: ConfirmationChange[] = input.changes.map((change) =>
    change.type === "move"
      ? { kind: "move", ref: change.ref, taskId: change.taskId, newStart: change.newStart }
      : { kind: "unschedule", ref: change.ref, taskId: change.taskId },
  );

  const revisionNumber = await confirmAiProposalRpc(supabase, day.id, input.baseRevision, changes);
  const tasks = await listTasksForDay(supabase, day.id);

  revalidatePath("/today");
  return { revisionNumber, tasks };
}

const proposalIdInputSchema = z.strictObject({ proposalId: z.uuid() });

/**
 * Confirms a proposal the server itself already generated and persisted (Phase 5.5) — the
 * app's actual confirmation flow, used identically for typed and voice input. `rawInput` is
 * untrusted, but the ONLY thing it can name is a proposal id; there is no field for a day, a
 * revision, or a change, so a client cannot supply anything for this to confirm other than
 * "which stored proposal" — the day, base revision and changes it is confirmed against all
 * come from the row itself, read inside `confirm_ai_proposal_by_id()` in the SAME transaction
 * that re-validates and applies them, so they cannot drift from what was actually generated.
 *
 * `getAiProposalById` here is only for the day id this function needs to re-read tasks with
 * afterward and for an early, friendly error; it is NOT what authorizes the confirmation — the
 * RPC's own row lock and ownership/status check are, independently, regardless of what this
 * read saw.
 */
export async function confirmPersistedAiProposal(
  rawInput: unknown,
): Promise<ConfirmAiProposalOutcome> {
  await requireUserForAction();
  const { proposalId } = proposalIdInputSchema.parse(rawInput);
  const supabase = await createSupabaseServerClient();

  const proposal = await getAiProposalById(supabase, proposalId);
  if (!proposal) throw new AiConfirmationError("proposal_unavailable");

  const revisionNumber = await confirmAiProposalByIdRpc(supabase, proposalId);
  const tasks = await listTasksForDay(supabase, proposal.dayId);

  revalidatePath("/today");
  return { revisionNumber, tasks };
}

/**
 * The user explicitly abandoning a pending proposal without confirming it (the review UI's
 * Cancel). Idempotent and silent on a foreign, missing, or already-resolved id — see
 * `discard_ai_proposal()` for why; this never reveals whether a given id exists.
 */
export async function discardPersistedAiProposal(rawInput: unknown): Promise<void> {
  await requireUserForAction();
  const { proposalId } = proposalIdInputSchema.parse(rawInput);
  const supabase = await createSupabaseServerClient();
  await discardAiProposalRpc(supabase, proposalId);
  revalidatePath("/today");
}

export type { AiProposal };
