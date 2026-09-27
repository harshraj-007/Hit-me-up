import { z } from "zod";
import { ALIAS_PATTERN } from "@/domain/ai-planning";

/**
 * Read-boundary validation for the JSONB columns on `ai_proposals` (Phase 5.5). Nothing in the
 * confirmation path trusts these — `confirm_ai_proposal_by_id()` reads `changes` straight from
 * the row in SQL, not through this code — this exists purely so the SERVICE layer never hands
 * the UI (or anything else) an unvalidated blob it read out of the database. The shapes mirror
 * existing TS types exactly (`ConfirmChangeRow`, `Rejection`, `ConflictAfter`) rather than
 * introducing a second, competing representation of any of them.
 */

const refField = z.string().regex(ALIAS_PATTERN);

/** Mirrors `ConfirmChangeRow` (`server/db/repositories/tasks.ts`) — what is stored in and
 *  read back from `ai_proposals.changes`. */
export const storedChangeRowSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ref: refField,
    task_id: z.uuid(),
    type: z.literal("move"),
    new_start: z.string(),
  }),
  z.strictObject({ ref: refField, task_id: z.uuid(), type: z.literal("unschedule") }),
]);

export const storedChangesSchema = z.array(storedChangeRowSchema).max(20);

/** Mirrors `Rejection` (`domain/ai-planning/types.ts`) — display-only, from
 *  `ai_proposals.rejected`. */
export const storedRejectionSchema = z.strictObject({
  code: z.enum([
    "unknown_ref",
    "resolved_task",
    "locked_task",
    "not_movable",
    "invalid_time",
    "outside_planning_day",
    "in_the_past",
    "window_invalid",
    "duration_changed",
    "no_change",
    "duplicate_change",
    "conflicting_changes",
    "too_many_changes",
    "unsupported_change",
  ]),
  message: z.string(),
  changeIndex: z.number().int().nullable(),
  ref: z.string().nullable(),
});

export const storedRejectedSchema = z.array(storedRejectionSchema).max(20);

/** Mirrors `ConflictAfter` — display-only, from `ai_proposals.conflicts_after`. */
export const storedConflictSchema = z.strictObject({
  firstTaskId: z.uuid(),
  secondTaskId: z.uuid(),
  firstRef: z.string().nullable(),
  secondRef: z.string().nullable(),
  involvesProposal: z.boolean(),
});

export const storedConflictsSchema = z.array(storedConflictSchema).max(400);

export const storedUnresolvedSchema = z.array(z.string()).max(10);

export type StoredChangeRow = z.infer<typeof storedChangeRowSchema>;
export type StoredRejection = z.infer<typeof storedRejectionSchema>;
export type StoredConflict = z.infer<typeof storedConflictSchema>;
