import { z } from "zod";
import {
  EOD_OUTCOMES,
  MAX_EOD_CARRY_FORWARD,
  MAX_EOD_PATTERNS,
  MAX_EOD_PATTERN_LENGTH,
  MAX_EOD_PATTERN_REFS,
  MAX_EOD_SUGGESTION_LENGTH,
  MAX_EOD_SUMMARY_LENGTH,
  MAX_EOD_TAKEAWAY_LENGTH,
  MAX_EOD_TASKS,
  type DroppedItem,
  type ParsedInterpretation,
} from "@/domain/eod";

/* ── Model output ─────────────────────────────────────────────────────────────
 * Zod establishes that the SHAPE is acceptable and nothing else; `validateEodInterpretation`
 * decides what is actually allowed. Every object is strict, so a hidden field (a task id, SQL, a
 * timestamp) cannot ride along. */

const refField = z.string().min(1).max(16);

/** The tool's own input schema — what the model is TOLD to produce. The prose limits here are the
 *  same ones the domain validator enforces, so a compliant model never trips them. */
export const eodToolInputSchema = z.strictObject({
  summary: z.string().min(1).max(MAX_EOD_SUMMARY_LENGTH),
  patterns: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(MAX_EOD_PATTERN_LENGTH),
        refs: z.array(refField).max(MAX_EOD_PATTERN_REFS),
      }),
    )
    .max(MAX_EOD_PATTERNS),
  carryForward: z
    .array(
      z.strictObject({
        ref: refField,
        suggestion: z.string().min(1).max(MAX_EOD_SUGGESTION_LENGTH),
      }),
    )
    .max(MAX_EOD_CARRY_FORWARD),
  takeaway: z.string().min(1).max(MAX_EOD_TAKEAWAY_LENGTH),
});

/** The envelope as RECEIVED: generous bounds (a hostile or confused model must not be able to send
 *  megabytes), list items left `unknown` so one bad item cannot sink the rest. */
const envelopeSchema = z.strictObject({
  summary: z.string().trim().min(1).max(2000),
  patterns: z.array(z.unknown()).max(20),
  carryForward: z.array(z.unknown()).max(20),
  takeaway: z.string().trim().min(1).max(2000),
});

const patternItemSchema = z.strictObject({
  text: z.string().trim().min(1).max(2000),
  refs: z.array(refField).max(20),
});
const carryItemSchema = z.strictObject({
  ref: refField,
  suggestion: z.string().trim().min(1).max(2000),
});

export type ParseRawInterpretationResult =
  { ok: true; parsed: ParsedInterpretation } | { ok: false; reason: string };

/** Untrusted provider payload → a shape-checked `ParsedInterpretation`. Never throws. */
export function parseRawInterpretation(raw: unknown): ParseRawInterpretationResult {
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { ok: false, reason: envelope.error.issues[0]?.message ?? "malformed payload" };
  }
  const rejected: DroppedItem[] = [];
  const patterns: ParsedInterpretation["patterns"] = [];
  envelope.data.patterns.forEach((item, index) => {
    const parsed = patternItemSchema.safeParse(item);
    if (parsed.success) patterns.push(parsed.data);
    else rejected.push({ section: "pattern", index, reason: "malformed item" });
  });
  const carryForward: ParsedInterpretation["carryForward"] = [];
  envelope.data.carryForward.forEach((item, index) => {
    const parsed = carryItemSchema.safeParse(item);
    if (parsed.success) carryForward.push(parsed.data);
    else rejected.push({ section: "carry_forward", index, reason: "malformed item" });
  });
  return {
    ok: true,
    parsed: {
      summary: envelope.data.summary,
      takeaway: envelope.data.takeaway,
      patterns,
      carryForward,
      rejected,
    },
  };
}

/* ── Stored shapes (read boundary) ────────────────────────────────────────────
 * `eod_reports.facts` / `.interpretation` are jsonb. Nothing in this app's own write path can
 * produce a malformed one, but a row is never trusted just because it came from our database —
 * it is re-parsed on every read, the same stance `ai_proposals` takes. */

const localWallTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const nonNegInt = z.number().int().min(0);

const taskFactSchema = z.strictObject({
  ref: z.string().regex(/^t[1-9]\d{0,3}$/),
  title: z.string().min(1).max(200),
  priority: z.enum(["high", "medium", "low"]),
  kind: z.enum(["fixed", "flexible", "deadline", "optional", "recurring"]),
  outcome: z.enum(EOD_OUTCOMES),
  start: localWallTime,
  end: localWallTime,
  durationMinutes: nonNegInt,
  completedAt: localWallTime.nullable(),
  minutesLate: z.number().int().nullable(),
  rescheduleCount: nonNegInt,
  netShiftMinutes: z.number().int().nullable(),
});

const totalsSchema = z.strictObject({
  total: nonNegInt,
  completed: nonNegInt,
  completedOnTime: nonNegInt,
  completedLate: nonNegInt,
  skipped: nonNegInt,
  unresolved: nonNegInt,
  slipped: nonNegInt,
  inProgress: nonNegInt,
  notYetDue: nonNegInt,
  unscheduled: nonNegInt,
  completionRatio: z.number().min(0).max(1).nullable(),
  plannedMinutes: nonNegInt,
  completedMinutes: nonNegInt,
  skippedMinutes: nonNegInt,
  unresolvedMinutes: nonNegInt,
  highPriorityTotal: nonNegInt,
  highPriorityCompleted: nonNegInt,
  rescheduledTasks: nonNegInt,
  totalReschedules: nonNegInt,
  planRevisions: nonNegInt,
});

export const storedEodFactsSchema = z.strictObject({
  planningDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1).max(64),
  asOf: localWallTime,
  tasks: z.array(taskFactSchema).max(MAX_EOD_TASKS),
  totals: totalsSchema,
});

export const storedEodInterpretationSchema = z.strictObject({
  summary: z.string().min(1).max(MAX_EOD_SUMMARY_LENGTH),
  patterns: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(MAX_EOD_PATTERN_LENGTH),
        refs: z.array(refField).max(MAX_EOD_PATTERN_REFS),
      }),
    )
    .max(MAX_EOD_PATTERNS),
  carryForward: z
    .array(
      z.strictObject({
        ref: refField,
        suggestion: z.string().min(1).max(MAX_EOD_SUGGESTION_LENGTH),
      }),
    )
    .max(MAX_EOD_CARRY_FORWARD),
  takeaway: z.string().min(1).max(MAX_EOD_TAKEAWAY_LENGTH),
});
