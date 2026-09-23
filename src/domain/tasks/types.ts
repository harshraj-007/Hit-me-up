/**
 * Canonical, server-side task model — the shape data-access and services deal in. This is
 * the domain's own type, not the UI's: `src/features/dashboard/types.ts` maps to a subset
 * of it for presentation (and additionally allows the derived `"current"` status; see
 * `deriveDisplayStatus`).
 */

/** Persisted statuses. "current" is deliberately not one of them — see derive-status.ts. */
export type TaskStatus = "upcoming" | "completed" | "skipped" | "late";

export type TaskPriority = "high" | "medium" | "low";

export type TaskKind = "fixed" | "flexible" | "deadline" | "optional" | "recurring";

/** Who created the task. Exists so a future AI planner can never silently rewrite the
 *  user's own tasks — it must always know which rows are and aren't its own. */
export type TaskSource = "user" | "planner";

export interface Task {
  id: string;
  userId: string;
  dayId: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  kind: TaskKind;
  source: TaskSource;
  scheduledStart: Date;
  scheduledEnd: Date;
  dueAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskHistoryEntry {
  id: string;
  taskId: string;
  previousStatus: TaskStatus | null;
  newStatus: TaskStatus;
  source: "user" | "system";
  changedAt: Date;
}
