import type { PlanningContext, UserIntent } from "@/domain/ai-planning";

export interface ProposeOptions {
  /** Caller cancellation. An implementation must also bound its own total time. */
  signal?: AbortSignal;
}

/**
 * The provider port. Domain and services depend on THIS; only an implementation
 * (`anthropic.ts`) knows an SDK. It returns the model's payload as `unknown` on purpose: a
 * provider's answer is untrusted, and the only way to turn it into a `ParsedProposal` is the
 * Zod transport parser (`parseRawProposal`), never a cast.
 *
 * An implementation must not touch the database, decide movability or duration, or persist
 * anything: it turns (context, intent) into one model payload, or throws an `AiError`.
 */
export interface ProposalGenerator {
  propose(context: PlanningContext, intent: UserIntent, options?: ProposeOptions): Promise<unknown>;
}
