import type { TaskStatus } from "./types";

/**
 * Statuses a task can never leave once reached. This is the load-bearing rule carried over
 * from Phase 2 (PROJECT_ARCHITECTURE.md principle 5): replanning — or any other code path —
 * must never silently move or revert work the user already resolved.
 */
export const RESOLVED_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "skipped"]);

export function isResolved(status: TaskStatus): boolean {
  return RESOLVED_STATUSES.has(status);
}

/**
 * The only status change a user can make is `upcoming → completed | skipped`. "Late" is not a
 * transition target: it is derived from the clock (see temporal.ts), so an overdue task is
 * still `upcoming` and can still be completed, skipped, rescheduled or replanned.
 */
export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (isResolved(from)) return false;
  return to === "completed" || to === "skipped";
}

export interface TransitionCheck {
  ok: boolean;
  reason?: string;
}

export function checkTransition(from: TaskStatus, to: TaskStatus): TransitionCheck {
  if (isResolved(from)) {
    return { ok: false, reason: `Task is already ${from} and cannot change status.` };
  }
  if (!isValidTransition(from, to)) {
    return { ok: false, reason: `Cannot change a task from ${from} to ${to}.` };
  }
  return { ok: true };
}
