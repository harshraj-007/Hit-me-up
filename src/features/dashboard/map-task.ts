import { deriveTaskTemporalState, type Task } from "@/domain/tasks";
import type { DashboardTask } from "./types";

/** The planning day a task belongs to, as far as display is concerned. */
export interface TaskDay {
  localDate: string;
  timezone: string;
}

/**
 * Domain `Task` (persisted shape) -> presentation `DashboardTask`. This is the one place the
 * clock is applied to a task for display: current/late/unscheduled are derived here from
 * `now`, never stored. `day` is the task's OWN planning day (its date and frozen timezone).
 */
export function toDashboardTask(task: Task, now: Date, day: TaskDay): DashboardTask {
  return {
    id: task.id,
    title: task.title,
    start: task.scheduledStart,
    end: task.scheduledEnd,
    status: deriveTaskTemporalState(task, now),
    priority: task.priority,
    kind: task.kind,
    locked: task.scheduleLocked,
    planningDate: day.localDate,
    timezone: day.timezone,
    dueAt: task.dueAt ?? undefined,
    note: task.notes ?? undefined,
  };
}
