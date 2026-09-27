import { MAX_TASK_DURATION_MS, type DayBounds } from "@/domain/days";

export type WindowCheck = { ok: true } | { ok: false; reason: string };

/**
 * The single rule for where a task may sit relative to its planning day:
 *
 *   dayStart <= start < dayEnd
 *   end > start
 *   end - start <= 24h
 *
 * `end` is deliberately NOT bounded by `dayEnd`: a Thursday task may run 23:30 → Friday 01:00
 * and is still a Thursday task. Used by task creation and by rescheduling.
 */
export function validateTaskWindow(start: Date, end: Date, bounds: DayBounds): WindowCheck {
  const s = start.getTime();
  const e = end.getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) {
    return { ok: false, reason: "Enter a valid start and end time." };
  }
  if (s < bounds.start.getTime() || s >= bounds.end.getTime()) {
    return { ok: false, reason: "A task has to start within its planning day." };
  }
  if (e <= s) return { ok: false, reason: "End time must be after the start time." };
  if (e - s > MAX_TASK_DURATION_MS) {
    return { ok: false, reason: "A task can last at most 24 hours." };
  }
  return { ok: true };
}
