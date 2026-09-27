import type { PlanningContext, UserIntent } from "@/domain/ai-planning";
import type { ProposalGenerator, ProposeOptions } from "./port";

export interface FakeCall {
  context: PlanningContext;
  intent: UserIntent;
  options?: ProposeOptions;
}

/**
 * A deterministic, in-memory `ProposalGenerator` for tests of anything that sits above the
 * provider (Phase 5.2's service, for one). No network, no SDK, no domain coupling. `response`
 * is either the payload to return or a function computing it from the request; a thrown value
 * is propagated as-is.
 */
export function createFakeGenerator(
  response: unknown | ((context: PlanningContext, intent: UserIntent) => unknown),
): ProposalGenerator & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  return {
    calls,
    async propose(context, intent, options) {
      calls.push({ context, intent, options });
      return typeof response === "function"
        ? (response as (c: PlanningContext, i: UserIntent) => unknown)(context, intent)
        : response;
    },
  };
}
