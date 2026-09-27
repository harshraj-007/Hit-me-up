import { z } from "zod";
import { MAX_PROPOSED_CHANGES } from "@/domain/ai-planning";
import { ALIAS_PATTERN } from "@/domain/ai-planning";
import { localDateSchema } from "./day";

/**
 * Transport boundary for a human-confirmed AI proposal (Phase 5.3). This is a FRESH trust
 * boundary, not a re-parse of the model's own output: `changes` here is expected to be exactly
 * `toConfirmationChanges(validationResult.accepted)` from a `valid` `ValidationResult` the
 * caller already computed — but nothing downstream (this schema, the service, or the RPC)
 * assumes that; every field is still checked and the database independently re-verifies
 * ownership and current eligibility for every `taskId`. `ref` is never used to look anything
 * up — see `src/domain/ai-planning/confirmation.ts` and the migration for why.
 *
 * Deliberately absent, the same way `rescheduleTaskInputSchema` refuses an `end`: a user id, an
 * email, a task's owner or source, a lock override, a "force" flag, a conflict override, an end
 * time, or a duration. There is no field in which any of them could even be expressed.
 */
const refField = z.string().regex(ALIAS_PATTERN);

export const confirmMoveChangeSchema = z.strictObject({
  ref: refField,
  taskId: z.uuid(),
  type: z.literal("move"),
  newStart: z.coerce.date(),
});

export const confirmUnscheduleChangeSchema = z.strictObject({
  ref: refField,
  taskId: z.uuid(),
  type: z.literal("unschedule"),
});

export const confirmAiProposalChangeSchema = z.discriminatedUnion("type", [
  confirmMoveChangeSchema,
  confirmUnscheduleChangeSchema,
]);

/**
 * `planningDate`, never a day id: the server resolves the actual day itself (matching every
 * other action in this app — the client only ever names a date). `changes` must reference each
 * task at most once: a duplicate is rejected here, before the RPC — the RPC independently
 * enforces the same rule and is still the one that matters, but there is no reason to make a
 * database round trip for something this schema can already tell is malformed.
 */
export const confirmAiProposalInputSchema = z
  .strictObject(
    {
      planningDate: localDateSchema,
      baseRevision: z.number().int().nonnegative(),
      changes: z.array(confirmAiProposalChangeSchema).min(1).max(MAX_PROPOSED_CHANGES),
    },
    {
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? "A confirmation names a planning date, the revision it was computed from, and the changes to apply — nothing else."
          : undefined,
    },
  )
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    input.changes.forEach((change, index) => {
      if (seen.has(change.taskId)) {
        ctx.addIssue({
          code: "custom",
          message: "The same task was referenced more than once.",
          path: ["changes", index, "taskId"],
        });
      }
      seen.add(change.taskId);
    });
  });

export type ConfirmAiProposalInput = z.infer<typeof confirmAiProposalInputSchema>;
