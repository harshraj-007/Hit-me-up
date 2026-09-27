"use server";

import { runAction, type ActionResult } from "@/server/errors";
import {
  generateAiProposal,
  loadPendingAiProposal,
  type AiProposalResult,
  type PendingAiProposal,
} from "@/server/services/ai-planning";
import {
  confirmPersistedAiProposal,
  discardPersistedAiProposal,
  type ConfirmAiProposalOutcome,
} from "@/server/services/ai-confirmation";

/**
 * Thin Server Action wrappers, matching `features/dashboard/actions.ts` exactly: no logic
 * lives here, only the parse-and-persist boundary the client component needs. Both typed and
 * voice input reach the SAME `generateAiProposalAction` — the only difference between them is
 * the `source` field inside `rawInput`, which `generateAiProposal` validates like any other
 * field (see `src/lib/validation/ai-planning.ts`). Neither this file nor the services behind it
 * treats a `ValidationResult` as permission to mutate: only `confirmAiProposalAction`, called
 * explicitly by the user confirming a specific PERSISTED proposal by id, ever reaches a
 * mutation — see `src/server/services/ai-confirmation.ts`.
 */

export async function generateAiProposalAction(
  input: unknown,
): Promise<ActionResult<AiProposalResult>> {
  return runAction(() => generateAiProposal(input));
}

/** `planningDate` only — never a proposal id or a day id — matching every other action's
 *  "the client names a date, the server resolves everything else" convention. */
export async function loadPendingAiProposalAction(
  planningDate: string,
): Promise<ActionResult<PendingAiProposal | null>> {
  return runAction(() => loadPendingAiProposal(planningDate));
}

export async function confirmAiProposalAction(
  input: unknown,
): Promise<ActionResult<ConfirmAiProposalOutcome>> {
  return runAction(() => confirmPersistedAiProposal(input));
}

export async function discardAiProposalAction(input: unknown): Promise<ActionResult<void>> {
  return runAction(() => discardPersistedAiProposal(input));
}
