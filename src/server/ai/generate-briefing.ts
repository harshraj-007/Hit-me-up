import "server-only";
import type { BriefingPlanningContext, ParsedProposal } from "@/domain/ai-planning";
import { parseRawProposal } from "@/lib/validation/ai-planning";
import type { BriefingPlanGenerator } from "./briefing-port";
import { AiError } from "./errors";
import type { ProposeOptions } from "./port";

/**
 * One provider request → one `ParsedProposal`, or an `AiError`. The payload only becomes a
 * `ParsedProposal` by passing the Zod transport parser (with creation allowed — the one flow that
 * may); a payload that fails it is a `malformed_response`, never retried or repaired. Nothing is
 * persisted or applied here.
 */
export async function generateParsedBriefingProposal(
  generator: BriefingPlanGenerator,
  context: BriefingPlanningContext,
  note: string | null,
  options?: ProposeOptions,
): Promise<ParsedProposal> {
  const payload = await generator.propose(context, note, options);
  const parsed = parseRawProposal(payload, { allowCreate: true });
  if (!parsed.ok) throw new AiError("malformed_response", `proposal rejected: ${parsed.reason}`);
  return {
    proposal: parsed.proposal,
    sourceIndexes: parsed.sourceIndexes,
    rejected: parsed.rejected,
  };
}
