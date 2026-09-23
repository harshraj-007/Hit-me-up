import type { Task, TaskStatus } from "./types";

/** Adds the one derived, never-persisted status back in for display. */
export type DisplayTaskStatus = TaskStatus | "current";

/**
 * "current" is computed at read time, not stored (see the schema comment on
 * `public.tasks.status` in the Phase 3 migration for why): a task still "upcoming" whose
 * scheduled window contains `now` displays as "current". Everything else displays exactly
 * as persisted. This mirrors how Phase 2's mock day already behaved — a snapshot computed
 * once per load, not continuously re-derived client-side.
 */
export function deriveDisplayStatus(
  task: Pick<Task, "status" | "scheduledStart" | "scheduledEnd">,
  now: Date,
): DisplayTaskStatus {
  if (task.status !== "upcoming") return task.status;
  return task.scheduledStart <= now && now < task.scheduledEnd ? "current" : "upcoming";
}
