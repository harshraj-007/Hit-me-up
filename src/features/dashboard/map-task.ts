import { deriveDisplayStatus, type Task } from "@/domain/tasks";
import type { DashboardTask } from "./types";

/**
 * Domain `Task` (server/persisted shape) -> presentation `DashboardTask` (what the
 * timeline renders). This is the one place "current" gets derived for display — see
 * domain/tasks/derive-status.ts for why it's computed here rather than stored.
 */
export function toDashboardTask(task: Task, now: Date): DashboardTask {
  return {
    id: task.id,
    title: task.title,
    start: task.scheduledStart,
    end: task.scheduledEnd,
    status: deriveDisplayStatus(task, now),
    priority: task.priority,
    kind: task.kind,
    dueAt: task.dueAt ?? undefined,
    note: task.notes ?? undefined,
  };
}
