import type { DayBounds } from "@/domain/days";
import type { Task } from "@/domain/tasks";
import { formatLocalWallTime } from "./local-time";
import type { FreeWindow } from "./types";

const FIVE_MIN_MS = 5 * 60_000;
export const MIN_FREE_WINDOW_MINUTES = 15;
export const MAX_FREE_WINDOWS = 24;

/** Round UP to the next whole 5 minutes, so a suggested start is never already behind the clock. */
function ceil5(ms: number): number {
  return Math.ceil(ms / FIVE_MIN_MS) * FIVE_MIN_MS;
}

/**
 * The gaps left in the REMAINING part of a planning day, deterministically — what a plan can
 * actually use. A window runs from the later of `now` (rounded up to 5 minutes) and the day's
 * start, to the next scheduled task or the day's end, and is kept only if it is at least
 * `MIN_FREE_WINDOW_MINUTES` long. Resolved tasks, unscheduled tasks and tasks already over hold
 * no time (the same set `detectScheduleConflicts` treats as live). The previous day's spillover
 * is passed in with the rest and blocks time at the start of the day like any other task.
 *
 * Advisory only: it helps the model aim, and the validator — not this — decides what is allowed.
 */
export function computeFreeWindows(
  tasks: readonly Task[],
  now: Date,
  dayBounds: DayBounds,
  timezone: string,
): FreeWindow[] {
  const from = ceil5(Math.max(now.getTime(), dayBounds.start.getTime()));
  const to = dayBounds.end.getTime();
  if (from >= to) return [];

  const busy = tasks
    .filter((t) => t.status === "upcoming" && !t.unscheduled && t.scheduledEnd.getTime() > from)
    .map((t) => ({ start: t.scheduledStart.getTime(), end: t.scheduledEnd.getTime() }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const windows: FreeWindow[] = [];
  const push = (start: number, end: number) => {
    const minutes = Math.floor((end - start) / 60_000);
    if (minutes >= MIN_FREE_WINDOW_MINUTES) {
      windows.push({
        start: formatLocalWallTime(new Date(start), timezone),
        end: formatLocalWallTime(new Date(end), timezone),
        minutes,
      });
    }
  };

  let cursor = from;
  for (const b of busy) {
    if (b.start > cursor) push(cursor, Math.min(b.start, to));
    cursor = Math.max(cursor, b.end);
    if (cursor >= to) break;
  }
  if (cursor < to) push(cursor, to);
  return windows.slice(0, MAX_FREE_WINDOWS);
}
