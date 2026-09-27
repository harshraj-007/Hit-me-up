import "server-only";
import { revalidatePath } from "next/cache";
import type { ConfirmationChange } from "@/domain/ai-planning";
import type { Task } from "@/domain/tasks";
import { confirmAiProposalInputSchema } from "@/lib/validation/ai-confirmation";
import { requireUserForAction } from "@/server/auth/session";
import {
  confirmAiProposal as confirmAiProposalRpc,
  listTasksForDay,
} from "@/server/db/repositories/tasks";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { ValidationError } from "@/server/errors";
import { viewDay } from "./day";

export interface ConfirmAiProposalOutcome {
  revisionNumber: number;
  /** The day's tasks after the confirmation — authoritative, re-read from the database. */
  tasks: Task[];
}

/**
 * Applies a proposal the user has explicitly confirmed. This is the ONLY place an AI-derived
 * change reaches the database, and it reaches it through exactly one call to the SECURITY
 * DEFINER `confirm_ai_proposal` RPC (`server/db/repositories/tasks.ts`) — this function issues
 * no direct table write of its own. The database is the final authority: everything this
 * service does before that call (parsing, resolving the day) is about identifying WHAT the
 * caller is asking to confirm, never about deciding whether it is allowed — ownership, current
 * task eligibility, the base revision and the resulting conflicts are all independently
 * re-verified in SQL, regardless of what a Phase 5.2 `ValidationResult` said earlier.
 *
 * `rawInput` is untrusted, exactly like every other action in this app; `dayId` is never
 * accepted from the caller; only a `planningDate`, which is resolved server-side the same way
 * `replanDay` resolves one. `NotFoundError` here means only "no plan exists for that day yet" —
 * a day the caller could not otherwise have gotten a proposal for — not any task-level
 * decision, which all happens inside the RPC.
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
