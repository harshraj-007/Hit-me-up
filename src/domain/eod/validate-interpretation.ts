import { REF_PLACEHOLDER } from "./render";
import {
  MAX_EOD_CARRY_FORWARD,
  MAX_EOD_PATTERNS,
  MAX_EOD_PATTERN_LENGTH,
  MAX_EOD_SUGGESTION_LENGTH,
  MAX_EOD_SUMMARY_LENGTH,
  MAX_EOD_TAKEAWAY_LENGTH,
  UNRESOLVED_OUTCOMES,
  type EodCarryForward,
  type EodFacts,
  type EodInterpretation,
  type EodPattern,
} from "./types";

/** A model payload whose SHAPE has been checked (Zod, in `lib/validation/eod.ts`) and nothing more.
 *  Each list item that failed its own shape check has already been moved into `rejected`. */
export interface ParsedInterpretation {
  summary: string;
  takeaway: string;
  patterns: EodPattern[];
  carryForward: EodCarryForward[];
  rejected: DroppedItem[];
}

export interface DroppedItem {
  section: "pattern" | "carry_forward";
  /** Index in the model's own list. */
  index: number;
  reason: string;
}

export type ValidatedInterpretation =
  | { ok: true; interpretation: EodInterpretation; dropped: DroppedItem[] }
  | { ok: false; reason: string };

/** Characters that have no place in plain prose shown to the user: markup, code, templating. */
const FORBIDDEN_PROSE = /[<>{}`\\]|[\u0000-\u001f\u007f]|:\/\/|\bwww\./i;
const DIGIT = /\d/;

/**
 * Plain-prose check shared by every model-written string. Returns a reason, or `null` if it passes.
 *
 * The no-digits rule is the point: every number and clock time a reader sees in a report comes
 * from the deterministic facts, so model prose that contains a digit is either redundant or a
 * fabrication — either way it is not allowed to slip through. (Task titles may contain digits;
 * they are never in model prose, only substituted from the facts at render time.)
 */
export function checkProse(
  text: string,
  maxLength: number,
  validRefs: ReadonlySet<string>,
): string | null {
  if (text.length === 0) return "empty";
  if (text.length > maxLength) return "too long";
  let unknownRef = false;
  const stripped = text.replace(REF_PLACEHOLDER, (_m, ref: string) => {
    if (!validRefs.has(ref)) unknownRef = true;
    return " ";
  });
  if (unknownRef) return "names a task that does not exist";
  if (/[[\]]/.test(stripped)) return "contains a bracket that is not a task placeholder";
  if (FORBIDDEN_PROSE.test(stripped)) return "contains markup, a link or a control character";
  if (DIGIT.test(stripped)) return "states a number or time (those come from the facts)";
  return null;
}

/**
 * The deterministic verdict on a model's interpretation — the only thing a report is ever built
 * from. Whole-response rules (the summary and the takeaway are required and must be clean prose)
 * fail the response; list items (patterns, carry-forward entries) are judged one by one, so a
 * single bad entry is dropped without discarding the rest.
 *
 *   - every task the model names must exist in the facts;
 *   - a carry-forward entry must name a task whose outcome is actually unresolved — a completed
 *     or skipped task can never be "carried forward", whatever the model claims;
 *   - no task is named twice in carry-forward;
 *   - prose is plain text with no numbers, times, markup or links.
 */
export function validateEodInterpretation(
  facts: EodFacts,
  parsed: ParsedInterpretation,
): ValidatedInterpretation {
  if (facts.tasks.length === 0) return { ok: false, reason: "there is nothing to interpret" };

  const outcomes = new Map(facts.tasks.map((t) => [t.ref, t.outcome]));
  const refs = new Set(outcomes.keys());
  const dropped: DroppedItem[] = [...parsed.rejected];

  const summaryProblem = checkProse(parsed.summary, MAX_EOD_SUMMARY_LENGTH, refs);
  if (summaryProblem) return { ok: false, reason: `summary ${summaryProblem}` };
  const takeawayProblem = checkProse(parsed.takeaway, MAX_EOD_TAKEAWAY_LENGTH, refs);
  if (takeawayProblem) return { ok: false, reason: `takeaway ${takeawayProblem}` };

  const patterns: EodPattern[] = [];
  parsed.patterns.forEach((pattern, index) => {
    const problem =
      checkProse(pattern.text, MAX_EOD_PATTERN_LENGTH, refs) ??
      (pattern.refs.every((r) => refs.has(r)) ? null : "names a task that does not exist");
    if (problem) {
      dropped.push({ section: "pattern", index, reason: problem });
    } else if (patterns.length < MAX_EOD_PATTERNS) {
      patterns.push({ text: pattern.text, refs: [...new Set(pattern.refs)] });
    }
  });

  const carryForward: EodCarryForward[] = [];
  const carried = new Set<string>();
  parsed.carryForward.forEach((entry, index) => {
    const outcome = outcomes.get(entry.ref);
    const problem =
      outcome === undefined
        ? "names a task that does not exist"
        : !UNRESOLVED_OUTCOMES.includes(outcome)
          ? "carries forward a task that is not unresolved"
          : carried.has(entry.ref)
            ? "names the same task twice"
            : checkProse(entry.suggestion, MAX_EOD_SUGGESTION_LENGTH, refs);
    if (problem) {
      dropped.push({ section: "carry_forward", index, reason: problem });
    } else if (carryForward.length < MAX_EOD_CARRY_FORWARD) {
      carried.add(entry.ref);
      carryForward.push({ ref: entry.ref, suggestion: entry.suggestion });
    }
  });

  return {
    ok: true,
    interpretation: {
      summary: parsed.summary,
      patterns,
      carryForward,
      takeaway: parsed.takeaway,
    },
    dropped,
  };
}
