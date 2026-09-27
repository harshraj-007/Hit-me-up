import "server-only";
import type { ParsedProposal, PlanningContext, UserIntent } from "@/domain/ai-planning";
import { parseRawProposal } from "@/lib/validation/ai-planning";
import { AiError } from "./errors";
import type { ProposalGenerator, ProposeOptions } from "./port";

/**
 * One provider request → one `ParsedProposal`, or an `AiError`. The provider's payload only
 * becomes a `ParsedProposal` by passing the Zod transport parser; a payload that fails it is a
 * `malformed_response` and is NOT retried or repaired. Nothing is persisted or applied here —
 * the result still has to go through `validateProposal` and, later, user confirmation.
 */
export async function generateParsedProposal(
  generator: ProposalGenerator,
  context: PlanningContext,
  intent: UserIntent,
  options?: ProposeOptions,
): Promise<ParsedProposal> {
  const payload = await generator.propose(context, intent, options);
  const parsed = parseRawProposal(payload);
  if (!parsed.ok) throw new AiError("malformed_response", `proposal rejected: ${parsed.reason}`);
  return {
    proposal: parsed.proposal,
    sourceIndexes: parsed.sourceIndexes,
    rejected: parsed.rejected,
  };
}
