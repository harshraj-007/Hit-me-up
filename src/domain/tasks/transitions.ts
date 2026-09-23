import type { TaskStatus } from "./types";

/**
 * Statuses a task can never leave once reached. This is the load-bearing rule carried over
 * from Phase 2 (PROJECT_ARCHITECTURE.md principle 5): replanning — or any other code path —
 * must never silently move or revert work the user already resolved.
 */
export const RESOLVED_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "skipped", "late"]);

export function isResolved(status: TaskStatus): boolean {
  return RESOLVED_STATUSES.has(status);
}

/**
 * The only status a task can be manually moved away from is "upcoming" (mirrors the three
 * action buttons Phase 2's TaskItem offers: Complete, Skip, Mark late). "current" isn't a
 * transition target here because it's never persisted — see derive-status.ts.
 */
export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (isResolved(from)) return false;
  if (from === to) return false;
  return to === "completed" || to === "skipped" || to === "late";
}

export interface TransitionCheck {
  ok: boolean;
  reason?: string;
}

export function checkTransition(from: TaskStatus, to: TaskStatus): TransitionCheck {
  if (isResolved(from)) {
    return { ok: false, reason: `Task is already ${from} and cannot change status.` };
  }
  if (from === to) {
    return { ok: false, reason: `Task is already ${to}.` };
  }
  if (!isValidTransition(from, to)) {
    return { ok: false, reason: `Cannot change a task from ${from} to ${to}.` };
  }
  return { ok: true };
}
