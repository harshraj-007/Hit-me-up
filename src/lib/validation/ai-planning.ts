import { z } from "zod";
import { isPlanDateAllowed } from "@/domain/days";
import {
  MAX_PROPOSED_CHANGES,
  MAX_REASON_LENGTH,
  MAX_UNDERSTOOD_LENGTH,
  MAX_UNRESOLVED_ITEMS,
  MAX_UNRESOLVED_LENGTH,
  MAX_USER_INTENT_LENGTH,
  type ParsedProposal,
  type ProposedTaskChange,
  type Rejection,
  type UserIntent,
} from "@/domain/ai-planning";
import { localDateSchema } from "./day";

/* ── User intent ──────────────────────────────────────────────────────────────
 * What the BROWSER may send. `submittedAt` is not accepted (strict object): the server stamps
 * it. The text is opaque user data — trimmed and length-bounded, never interpreted. */
export const userIntentInputSchema = z.strictObject({
  id: z.uuid(),
  source: z.enum(["typed", "voice"]),
  text: z.string().trim().min(1, "Say what you'd like to change.").max(MAX_USER_INTENT_LENGTH),
  planningDate: localDateSchema,
});

export type ParseIntentResult =
  { ok: true; intent: UserIntent } | { ok: false; issues: { path: string; message: string }[] };

/**
 * Validates untrusted input into a `UserIntent`. The planning-horizon rule needs "today" in the
 * user's timezone and the submission time, both of which the SERVER supplies.
 */
export function parseUserIntent(
  raw: unknown,
  server: { submittedAt: Date; todayLocal: string },
): ParseIntentResult {
  const result = userIntentInputSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }
  if (!isPlanDateAllowed(result.data.planningDate, server.todayLocal)) {
    return {
      ok: false,
      issues: [{ path: "planningDate", message: "Pick a date from today up to a year ahead." }],
    };
  }
  return { ok: true, intent: { ...result.data, submittedAt: server.submittedAt } };
}

/* ── Model output ─────────────────────────────────────────────────────────────
 * Zod establishes that the SHAPE is acceptable. It does not make anything trusted: refs,
 * times and eligibility are decided later by `validateProposal`. Every change object is
 * strict, so a hidden field (an end time, a task id, SQL, …) cannot ride along. */
const refField = z.string().min(1).max(64);
const reasonField = z.string().trim().min(1).max(MAX_REASON_LENGTH);

export const moveChangeSchema = z.strictObject({
  kind: z.literal("move"),
  ref: refField,
  // Shape is checked by the domain (a real local date/time in the day's timezone).
  newStart: z.string().min(1).max(40),
  reason: reasonField,
});

export const unscheduleChangeSchema = z.strictObject({
  kind: z.literal("unschedule"),
  ref: refField,
  reason: reasonField,
});

export const proposedChangeSchema = z.discriminatedUnion("kind", [
  moveChangeSchema,
  unscheduleChangeSchema,
]);

/** The envelope. `changes` items stay `unknown` here so one bad item cannot sink the rest. */
export const rawProposalEnvelopeSchema = z.strictObject({
  understood: z.string().trim().min(1).max(MAX_UNDERSTOOD_LENGTH),
  changes: z.array(z.unknown()).max(MAX_PROPOSED_CHANGES),
  unresolved: z
    .array(z.string().trim().min(1).max(MAX_UNRESOLVED_LENGTH))
    .max(MAX_UNRESOLVED_ITEMS),
});

/**
 * The STRICT full proposal shape (typed changes). It is the single source of truth for the
 * JSON Schema handed to a provider as its structured-output tool, so what the model is asked
 * for cannot drift from what the parser accepts. Parsing model output still goes through
 * `parseRawProposal`, which is tolerant per change.
 */
export const proposalOutputSchema = z.strictObject({
  understood: z.string().trim().min(1).max(MAX_UNDERSTOOD_LENGTH),
  changes: z.array(proposedChangeSchema).max(MAX_PROPOSED_CHANGES),
  unresolved: z
    .array(z.string().trim().min(1).max(MAX_UNRESOLVED_LENGTH))
    .max(MAX_UNRESOLVED_ITEMS),
});

export type ParseProposalResult =
  | ({ ok: true } & ParsedProposal)
  | { ok: false; reason: "malformed" | "too_many_changes"; message: string };

const DURATION_LIKE_KEY = /end|duration|until|length|minutes|hours/i;
const KNOWN_KINDS = new Set(["move", "unschedule"]);
const SAFE_LABEL = /^[a-z_]{1,32}$/;
const SAFE_REF = /^t[1-9]\d{0,3}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refOf(raw: unknown): string | null {
  return isRecord(raw) && typeof raw.ref === "string" && SAFE_REF.test(raw.ref) ? raw.ref : null;
}

/** Explains, with fixed text only, why one change was not accepted at the transport boundary. */
function rejectRawChange(raw: unknown, index: number): Rejection {
  const ref = refOf(raw);
  if (isRecord(raw) && typeof raw.kind === "string" && KNOWN_KINDS.has(raw.kind)) {
    const allowed =
      raw.kind === "move" ? ["kind", "ref", "newStart", "reason"] : ["kind", "ref", "reason"];
    const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
    if (extra.some((k) => DURATION_LIKE_KEY.test(k))) {
      return {
        code: "duration_changed",
        message:
          "Changing a task's duration or end time isn't supported; a move only sets a new start.",
        changeIndex: index,
        ref,
      };
    }
    return {
      code: "unsupported_change",
      message:
        extra.length > 0
          ? "That change contained fields that aren't allowed."
          : "That change was incomplete or malformed.",
      changeIndex: index,
      ref,
    };
  }
  const kind =
    isRecord(raw) && typeof raw.kind === "string" && SAFE_LABEL.test(raw.kind) ? raw.kind : null;
  return {
    code: "unsupported_change",
    message: kind
      ? `"${kind}" isn't a supported kind of change.`
      : "That kind of change isn't supported.",
    changeIndex: index,
    ref,
  };
}

/**
 * Transport boundary for model output. Whole-proposal problems (bad envelope, too many
 * changes) fail the parse; a single unsupported or malformed change becomes a rejection so the
 * valid ones can still be judged. `create`, `delete`, `change_duration`, extra fields and
 * anything else that isn't exactly `move` or `unschedule` lands in `rejected` — never in
 * `proposal.changes`.
 */
export function parseRawProposal(raw: unknown): ParseProposalResult {
  const envelope = rawProposalEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    const tooMany = envelope.error.issues.some(
      (i) => i.code === "too_big" && i.path[0] === "changes",
    );
    return tooMany
      ? {
          ok: false,
          reason: "too_many_changes",
          message: `A proposal can change at most ${MAX_PROPOSED_CHANGES} tasks.`,
        }
      : { ok: false, reason: "malformed", message: "The proposal wasn't in the expected format." };
  }

  const changes: ProposedTaskChange[] = [];
  const sourceIndexes: number[] = [];
  const rejected: Rejection[] = [];
  envelope.data.changes.forEach((item, index) => {
    const parsed = proposedChangeSchema.safeParse(item);
    if (parsed.success) {
      changes.push(parsed.data);
      sourceIndexes.push(index);
    } else {
      rejected.push(rejectRawChange(item, index));
    }
  });

  return {
    ok: true,
    proposal: {
      understood: envelope.data.understood,
      changes,
      unresolved: envelope.data.unresolved,
    },
    sourceIndexes,
    rejected,
  };
}
