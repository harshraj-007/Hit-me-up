/**
 * Presentation-level types for the dashboard shell. These describe what a task looks like
 * on screen; they intentionally do not import from `domain/` or `server/` and are not the
 * persisted schema. Once Phase 3 defines the domain model, this file maps to (rather than
 * becomes) it.
 */

export type TaskStatus = "upcoming" | "current" | "completed" | "late" | "skipped";

export type TaskPriority = "high" | "medium" | "low";

/** How fixed a task's timing is — mirrors the planning constraints in PROJECT_ARCHITECTURE.md §8. */
export type TaskKind = "fixed" | "flexible" | "deadline" | "optional" | "recurring";

export interface DashboardTask {
  id: string;
  title: string;
  start: Date;
  end: Date;
  status: TaskStatus;
  priority: TaskPriority;
  kind: TaskKind;
  /** Present only for kind === "deadline". */
  dueAt?: Date;
  note?: string;
}

export interface DaySummary {
  completed: number;
  total: number;
  remainingMinutes: number;
}
