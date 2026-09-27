import type { Task } from "./types";

/**
 * What a task looks like *right now*. Only `completed`, `skipped` and (via the `unscheduled`
 * flag) `unscheduled` come from stored data; `upcoming`, `current` and `late` are computed
 * from the clock and never persisted, so there is nothing to expire and no background job.
 */
export type TemporalState =
  "upcoming" | "current" | "late" | "unscheduled" | "completed" | "skipped";

/**
 * The single place the clock is turned into a task state. Intervals are half-open,
 * `[scheduledStart, scheduledEnd)`, so two back-to-back tasks are never "current" at the same
 * instant:
 *
 *   resolved                      → completed | skipped   (the clock is irrelevant)
 *   unresolved and unscheduled    → unscheduled           (its stored times are not a claim)
 *   now <  start                  → upcoming
 *   start <= now < end            → current
 *   now >= end                    → late
 */
export function deriveTaskTemporalState(
  task: Pick<Task, "status" | "scheduledStart" | "scheduledEnd" | "unscheduled">,
  now: Date,
): TemporalState {
  if (task.status !== "upcoming") return task.status;
  if (task.unscheduled) return "unscheduled";
  const t = now.getTime();
  if (t < task.scheduledStart.getTime()) return "upcoming";
  if (t < task.scheduledEnd.getTime()) return "current";
  return "late";
}
