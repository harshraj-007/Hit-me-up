"use server";

import { runAction, type ActionResult } from "@/server/errors";
import { generateAiProposal, type AiProposalResult } from "@/server/services/ai-planning";
import {
  confirmAiProposal,
  type ConfirmAiProposalOutcome,
} from "@/server/services/ai-confirmation";

/**
 * Thin Server Action wrappers, matching `features/dashboard/actions.ts` exactly: no logic
 * lives here, only the parse-and-persist boundary the client component needs. Both typed and
 * voice input reach this SAME action — the only difference between them is the `source` field
 * inside `rawInput`, which `generateAiProposal` validates like any other field (see
 * `src/lib/validation/ai-planning.ts`). Neither this file nor the services behind it treats a
 * `ValidationResult` as permission to mutate: only `confirmAiProposalAction`, called
 * explicitly by the user confirming a specific proposal, ever reaches `confirmAiProposal()`.
 */

export async function generateAiProposalAction(
  input: unknown,
): Promise<ActionResult<AiProposalResult>> {
  return runAction(() => generateAiProposal(input));
}

export async function confirmAiProposalAction(
  input: unknown,
): Promise<ActionResult<ConfirmAiProposalOutcome>> {
  return runAction(() => confirmAiProposal(input));
}
