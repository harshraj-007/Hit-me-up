/**
 * Presentation-level types for the dashboard. These describe what a task looks like on
 * screen; the persisted model lives in `src/domain/tasks`.
 */
import type { TemporalState } from "@/domain/tasks";

/** What a task looks like right now (derived from the clock + stored data). */
export type TaskStatus = TemporalState;

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
  /** The user moved this by hand; automatic replanning won't touch it. */
  locked: boolean;
  /** The task's own planning day (YYYY-MM-DD) and that day's frozen timezone. A spillover
   *  task carries the PREVIOUS day's, which can differ from the day on screen. */
  planningDate: string;
  timezone: string;
  /** Present only for kind === "deadline". */
  dueAt?: Date;
  note?: string;
}
