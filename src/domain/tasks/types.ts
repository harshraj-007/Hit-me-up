/**
 * Canonical, server-side task model — the shape data-access and services deal in. This is
 * the domain's own type, not the UI's: `src/features/dashboard/types.ts` maps to a subset
 * of it for presentation (and additionally allows the derived temporal states; see
 * `deriveTaskTemporalState`).
 */

/**
 * Persisted statuses. There is exactly one meaning of each word:
 *  - `completed` / `skipped` are terminal and stored;
 *  - `upcoming` means "unresolved" and is stored;
 *  - "current" and "late" are *derived from the clock* and are never stored (see temporal.ts).
 */
export type TaskStatus = "upcoming" | "completed" | "skipped";

export type TaskPriority = "high" | "medium" | "low";

export type TaskKind = "fixed" | "flexible" | "deadline" | "optional" | "recurring";

/** Who created the task. The planner may only ever move tasks it created itself. */
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
  /** Set when the user moved the task by hand; automatic replanning must never undo that. */
  scheduleLocked: boolean;
  /** Set by replanning when the task could not fit in the remaining day. The task keeps its
   *  previous times (it is never deleted or shortened) but no longer claims a slot. */
  unscheduled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskHistoryEntry {
  id: string;
  taskId: string;
  event: "created" | "status_changed" | "rescheduled" | "replanned";
  previousStatus: TaskStatus | null;
  newStatus: TaskStatus;
  /** `ai` since Phase 5.3: a change applied by confirming an AI proposal. */
  source: "user" | "system" | "ai";
  previousStart: Date | null;
  previousEnd: Date | null;
  newStart: Date | null;
  newEnd: Date | null;
  revisionId: string | null;
  changedAt: Date;
}
