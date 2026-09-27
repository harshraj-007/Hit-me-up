import type { DayBounds } from "@/domain/days";
import { isResolved, type Task } from "@/domain/tasks";
import { validateTaskWindow } from "./window";

export type RescheduleResult = { ok: true; start: Date; end: Date } | { ok: false; reason: string };

/** A task's duration in ms: the one value rescheduling must preserve. It is not stored as a
 *  number — it IS `scheduledEnd - scheduledStart`. */
export function taskDurationMs(task: Pick<Task, "scheduledStart" | "scheduledEnd">): number {
  return task.scheduledEnd.getTime() - task.scheduledStart.getTime();
}

/**
 * Rescheduling MOVES a task; it never resizes it. Given only the NEW START, the window is
 * `[newStart, newStart + originalDuration)` — the end is derived here from the task as it is
 * stored, never taken from the caller, so a client cannot lengthen or shorten a task by
 * rescheduling it. (The duration is measured in real elapsed time, so a 90-minute task stays
 * 90 minutes even when the move crosses a DST change.)
 *
 * Pure: the caller supplies the clock and the task's own planning-day bounds. Accepted for any
 * unresolved task — including an overdue one, one replanning couldn't fit, and one the user
 * already moved by hand (it simply stays pinned) — but never for a resolved task, never for a
 * start outside the planning day, and never for a window that has already entirely passed. The
 * END may cross midnight (the task stays on its planning day) as long as the fixed duration
 * keeps it within 24 hours.
 */
export function validateReschedule(
  task: Pick<Task, "status" | "scheduledStart" | "scheduledEnd">,
  newStart: Date,
  bounds: DayBounds,
  now: Date,
): RescheduleResult {
  if (isResolved(task.status)) {
    return { ok: false, reason: `A ${task.status} task can't be rescheduled.` };
  }
  if (!Number.isFinite(newStart.getTime())) {
    return { ok: false, reason: "Enter a valid start time." };
  }
  const end = new Date(newStart.getTime() + taskDurationMs(task));
  const window = validateTaskWindow(newStart, end, bounds);
  if (!window.ok) return window;
  if (end.getTime() <= now.getTime()) {
    return { ok: false, reason: "That time has already passed." };
  }
  return { ok: true, start: newStart, end };
}
