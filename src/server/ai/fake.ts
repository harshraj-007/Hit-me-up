import type { PlanningContext, UserIntent } from "@/domain/ai-planning";
import type { EodFacts } from "@/domain/eod";
import type { EodInterpreter, InterpretOptions } from "./eod-port";
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

export interface FakeEodCall {
  facts: EodFacts;
  options?: InterpretOptions;
}

/**
 * A deterministic, in-memory `EodInterpreter` for tests of anything that sits above the provider
 * (the end-of-day service). No network, no SDK. `response` is the payload to return, or a function
 * computing it from the facts; a thrown value is propagated as-is.
 */
export function createFakeEodInterpreter(
  response: unknown | ((facts: EodFacts) => unknown),
): EodInterpreter & { calls: FakeEodCall[] } {
  const calls: FakeEodCall[] = [];
  return {
    calls,
    async interpret(facts, options) {
      calls.push({ facts, options });
      return typeof response === "function"
        ? (response as (facts: EodFacts) => unknown)(facts)
        : response;
    },
  };
}
