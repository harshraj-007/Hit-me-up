import type { BriefingPlanningContext } from "@/domain/ai-planning";
import type { ProposeOptions } from "./port";

/**
 * The provider port for plan-from-briefing (Phase 8). Like `ProposalGenerator` it returns the
 * model's payload as `unknown` — untrusted — and only the Zod transport parser can turn it into a
 * `ParsedProposal`. An implementation must not touch the database, decide feasibility, create a
 * notification or persist anything: it turns (context, optional note) into one model payload, or
 * throws an `AiError`. `note` is the user's optional extra instruction (untrusted text).
 */
export interface BriefingPlanGenerator {
  propose(
    context: BriefingPlanningContext,
    note: string | null,
    options?: ProposeOptions,
  ): Promise<unknown>;
}
