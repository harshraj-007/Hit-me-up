import type { DayBounds } from "@/domain/days";
import type { Task, TaskPriority } from "@/domain/tasks";
import { detectScheduleConflicts, type ScheduleConflict } from "./conflicts";

export type ReplanTask = Pick<
  Task,
  | "id"
  | "dayId"
  | "status"
  | "source"
  | "kind"
  | "priority"
  | "scheduledStart"
  | "scheduledEnd"
  | "dueAt"
  | "createdAt"
  | "scheduleLocked"
  | "unscheduled"
>;

/** One task whose persisted schedule would change. Only real changes are ever reported. */
export interface ScheduleChange {
  taskId: string;
  previousStart: Date;
  previousEnd: Date;
  previousUnscheduled: boolean;
  newStart: Date;
  newEnd: Date;
  newUnscheduled: boolean;
}

export type UnscheduledReason = "no-room" | "past-due-date" | "day-over";

export interface UnscheduledTask {
  taskId: string;
  reason: UnscheduledReason;
}

export interface ReplanResult {
  /** What to persist. Empty means the schedule is already what a replan would produce. */
  changes: ScheduleChange[];
  /** Every planner task that does not fit in the remaining day (new and pre-existing). */
  unscheduled: UnscheduledTask[];
  /** Overlaps that remain after replanning — user tasks are never moved to resolve these. */
  conflicts: ScheduleConflict[];
}

export interface ReplanInput {
  /** The planning day being replanned. Tasks of any other day are obstacles, never moved. */
  dayId: string;
  now: Date;
  tasks: readonly ReplanTask[];
  /** The real local day: midnight → next midnight, as UTC instants. */
  dayBounds: DayBounds;
}

const MINUTE_MS = 60_000;
const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };

function ceilToMinute(ms: number): number {
  return Math.ceil(ms / MINUTE_MS) * MINUTE_MS;
}

function isCurrent(task: ReplanTask, nowMs: number): boolean {
  return (
    !task.unscheduled &&
    task.scheduledStart.getTime() <= nowMs &&
    nowMs < task.scheduledEnd.getTime()
  );
}

/**
 * The ONLY tasks automatic replanning may move: unresolved, belonging to the planning day
 * being replanned, created by the planner, not pinned by a manual move, not `fixed`, and not
 * the task being worked on right now. (A task replanning previously couldn't fit is eligible
 * again — it holds no slot.) A task of another day — e.g. yesterday's cross-midnight
 * spillover — is never movable from here, only an obstacle.
 */
export function isAutoMovable(task: ReplanTask, now: Date, dayId: string): boolean {
  return (
    task.dayId === dayId &&
    task.status === "upcoming" &&
    task.source === "planner" &&
    !task.scheduleLocked &&
    task.kind !== "fixed" &&
    !isCurrent(task, now.getTime())
  );
}

interface Interval {
  start: number;
  end: number;
}

/** Free gaps inside `window` once `blocked` intervals are removed. */
function freeGaps(window: Interval, blocked: Interval[]): Interval[] {
  const clipped = blocked
    .map((b) => ({ start: Math.max(b.start, window.start), end: Math.min(b.end, window.end) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const gaps: Interval[] = [];
  let cursor = window.start;
  for (const b of clipped) {
    if (b.start > cursor) gaps.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < window.end) gaps.push({ start: cursor, end: window.end });
  return gaps;
}

/**
 * Deterministic, rule-based replanning of what is left of the day. Pure: no I/O, no clock of
 * its own (`now` is an input), and the same input always yields the same output.
 *
 *  1. Everything not auto-movable is a fixed obstacle: completed/skipped work is history,
 *     and unresolved user / locked / fixed / current tasks keep their slots.
 *  2. The planning window is `[max(now rounded up to the minute, day start), day end)`. For a
 *     future day `now` is before the day starts, so this is the whole day.
 *  3. Movable tasks are ordered high → low priority, then earliest due date, then original
 *     start, then creation time, then id.
 *  4. Each goes, at its full duration (never truncated), into the earliest gap that fits and
 *     still meets its `due_at`. Nothing is placed in the past or on top of anything else.
 *  5. A task that fits nowhere is reported as unscheduled — kept, not deleted.
 */
export function replanRemainingDay({ dayId, now, tasks, dayBounds }: ReplanInput): ReplanResult {
  const nowMs = now.getTime();
  const windowStart = Math.max(ceilToMinute(nowMs), dayBounds.start.getTime());
  const windowEnd = dayBounds.end.getTime();
  const hasWindow = windowStart < windowEnd;

  const movable = tasks.filter((t) => isAutoMovable(t, now, dayId));
  const movableIds = new Set(movable.map((t) => t.id));

  const obstacles: Interval[] = tasks
    .filter((t) => t.status === "upcoming" && !t.unscheduled && !movableIds.has(t.id))
    .map((t) => ({ start: t.scheduledStart.getTime(), end: t.scheduledEnd.getTime() }));

  const gaps = hasWindow ? freeGaps({ start: windowStart, end: windowEnd }, obstacles) : [];

  const ordered = [...movable].sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) ||
      a.scheduledStart.getTime() - b.scheduledStart.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );

  const changes: ScheduleChange[] = [];
  const unscheduled: UnscheduledTask[] = [];
  const finalSchedule = new Map<string, { start: Date; end: Date; unscheduled: boolean }>();

  for (const task of ordered) {
    const duration = task.scheduledEnd.getTime() - task.scheduledStart.getTime();
    const gap = gaps.find((g) => g.end - g.start >= duration);

    let reason: UnscheduledReason | null = null;
    let start = 0;
    if (!hasWindow) reason = "day-over";
    else if (!gap) reason = "no-room";
    else {
      start = gap.start;
      if (task.dueAt && start + duration > task.dueAt.getTime()) reason = "past-due-date";
    }

    if (reason) {
      unscheduled.push({ taskId: task.id, reason });
      finalSchedule.set(task.id, {
        start: task.scheduledStart,
        end: task.scheduledEnd,
        unscheduled: true,
      });
      if (!task.unscheduled) {
        changes.push({
          taskId: task.id,
          previousStart: task.scheduledStart,
          previousEnd: task.scheduledEnd,
          previousUnscheduled: false,
          newStart: task.scheduledStart,
          newEnd: task.scheduledEnd,
          newUnscheduled: true,
        });
      }
      continue;
    }

    gap!.start = start + duration; // consume the front of the gap; the rest stays free
    const newStart = new Date(start);
    const newEnd = new Date(start + duration);
    finalSchedule.set(task.id, { start: newStart, end: newEnd, unscheduled: false });
    const moved =
      task.unscheduled ||
      task.scheduledStart.getTime() !== newStart.getTime() ||
      task.scheduledEnd.getTime() !== newEnd.getTime();
    if (moved) {
      changes.push({
        taskId: task.id,
        previousStart: task.scheduledStart,
        previousEnd: task.scheduledEnd,
        previousUnscheduled: task.unscheduled,
        newStart,
        newEnd,
        newUnscheduled: false,
      });
    }
  }

  // Previously-unscheduled tasks that are still unscheduled aren't in `ordered` if they were
  // ineligible (e.g. user-sourced); only eligible ones are reported, which is what we own.
  const after = tasks.map((t) => {
    const next = finalSchedule.get(t.id);
    return next
      ? { ...t, scheduledStart: next.start, scheduledEnd: next.end, unscheduled: next.unscheduled }
      : t;
  });

  return { changes, unscheduled, conflicts: detectScheduleConflicts(after, now) };
}

/** A revision is appended only when the persisted schedule would actually change. */
export function shouldCreatePlanRevision(result: Pick<ReplanResult, "changes">): boolean {
  return result.changes.length > 0;
}
