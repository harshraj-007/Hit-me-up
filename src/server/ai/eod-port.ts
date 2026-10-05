import type { EodFacts } from "@/domain/eod";

export interface InterpretOptions {
  /** Caller cancellation. An implementation must also bound its own total time. */
  signal?: AbortSignal;
}

/**
 * The provider port for the end-of-day review. Domain and services depend on THIS; only an
 * implementation (`anthropic-eod.ts`) knows an SDK. It returns the model's payload as `unknown`
 * on purpose: a provider's answer is untrusted, and the only way to turn it into an
 * `EodInterpretation` is the Zod shape parser plus `validateEodInterpretation`, never a cast.
 *
 * An implementation must not touch the database, compute or alter any fact, or persist anything:
 * it turns the deterministic facts into one model payload, or throws an `AiError`.
 */
export interface EodInterpreter {
  interpret(facts: EodFacts, options?: InterpretOptions): Promise<unknown>;
}
