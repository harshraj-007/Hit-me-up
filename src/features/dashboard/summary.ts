import type { DashboardTask } from "./types";

/**
 * Minutes of still-unresolved, scheduled work that fall inside `window` (the day on screen)
 * from now on. Each task counts only from `max(start, now, window.start)` to
 * `min(end, window.end)`, so the part of a cross-midnight task that belongs to the next day is
 * not "left today", and a previous day's spillover counts only for the hours it occupies in
 * THIS day. Late tasks contribute nothing (their window is over) and unscheduled ones hold no slot.
 */
export function computeRemainingMinutes(
  tasks: readonly DashboardTask[],
  now: Date,
  window: { start: Date; end: Date },
): number {
  const total = tasks.reduce((sum, t) => {
    if (t.status === "completed" || t.status === "skipped" || t.status === "unscheduled")
      return sum;
    const from = Math.max(t.start.getTime(), now.getTime(), window.start.getTime());
    const to = Math.min(t.end.getTime(), window.end.getTime());
    return to > from ? sum + (to - from) / 60_000 : sum;
  }, 0);
  return Math.round(total);
}
