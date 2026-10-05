import "server-only";
import {
  validateEodInterpretation,
  type DroppedItem,
  type EodFacts,
  type EodInterpretation,
} from "@/domain/eod";
import { parseRawInterpretation } from "@/lib/validation/eod";
import { AiError } from "./errors";
import type { EodInterpreter, InterpretOptions } from "./eod-port";

export interface GeneratedInterpretation {
  interpretation: EodInterpretation;
  /** List entries the validator refused (unknown task, a completed task "carried forward", a
   *  number in prose, …). Never persisted and never shown — surfaced only so the caller can log a
   *  count. */
  dropped: DroppedItem[];
}

/**
 * One provider request → one VALIDATED interpretation, or an `AiError`. Two gates, in order: the
 * Zod shape parser, then the deterministic domain validator against the facts the model was
 * shown. A payload that fails either wholesale (wrong shape, or a summary/takeaway that is not
 * clean prose) is a `malformed_response` and is NOT retried or repaired. Nothing is persisted
 * here — this module never sees a repository.
 */
export async function generateEodInterpretation(
  interpreter: EodInterpreter,
  facts: EodFacts,
  options?: InterpretOptions,
): Promise<GeneratedInterpretation> {
  const payload = await interpreter.interpret(facts, options);
  const parsed = parseRawInterpretation(payload);
  if (!parsed.ok) {
    throw new AiError("malformed_response", `interpretation rejected: ${parsed.reason}`, "review");
  }
  const verdict = validateEodInterpretation(facts, parsed.parsed);
  if (!verdict.ok) {
    throw new AiError("malformed_response", `interpretation rejected: ${verdict.reason}`, "review");
  }
  return { interpretation: verdict.interpretation, dropped: verdict.dropped };
}
