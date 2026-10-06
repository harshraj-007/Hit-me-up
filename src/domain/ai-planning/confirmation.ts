import type { NewTaskKind, ValidatedChange } from "./types";
import type { TaskPriority } from "@/domain/tasks";

/**
 * The wire shape of one change sent to the confirmation RPC. `ref` is carried through only for
 * the caller's own audit trail — see the migration header for why it is never resolved back to
 * a task here or in SQL. `taskId` is what the trusted server itself resolved during proposal
 * generation (`ValidatedChange.taskId`); it authorizes nothing by itself, and the database
 * independently re-verifies ownership and full current-state eligibility for it (see
 * `confirm_ai_proposal` in supabase/migrations). There is deliberately no `newEnd` and no
 * duration field on a move: it carries only its new start, exactly like `ValidatedMove`.
 *
 * A `create` (Phase 8) is a NEW task: it has no task id (the database mints it), its `ref` is a
 * server-assigned `n1`, `n2`, … and it carries a duration in minutes — never an end, never a
 * source (the database always writes `planner`), never notes. The database re-validates every
 * field of it independently, exactly as it does for a move.
 */
export type ConfirmationChange =
  | { kind: "move"; ref: string; taskId: string; newStart: Date }
  | { kind: "unschedule"; ref: string; taskId: string }
  | {
      kind: "create";
      ref: string;
      title: string;
      start: Date;
      durationMinutes: number;
      priority: TaskPriority;
      taskKind: NewTaskKind;
    };

/**
 * Only a `valid` `ValidationResult` (Phase 5.0/5.2) may ever be confirmed — a `partially_valid`
 * or `invalid` one has rejections or remaining conflicts that a human has not had the chance to
 * review as a whole, and confirming it would silently apply a subset the user never explicitly
 * saw approved. This is a pure, cheap check the caller runs before ever building a
 * confirmation request; the RPC re-derives everything security-relevant on its own regardless.
 */
export function toConfirmationChanges(
  accepted: readonly ValidatedChange[],
): readonly ConfirmationChange[] {
  return accepted.map((change): ConfirmationChange => {
    switch (change.kind) {
      case "move":
        return { kind: "move", ref: change.ref, taskId: change.taskId, newStart: change.newStart };
      case "unschedule":
        return { kind: "unschedule", ref: change.ref, taskId: change.taskId };
      case "create":
        return {
          kind: "create",
          ref: change.ref,
          title: change.title,
          start: change.start,
          durationMinutes: change.durationMinutes,
          priority: change.priority,
          taskKind: change.taskKind,
        };
    }
  });
}
