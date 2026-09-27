/**
 * Planning-day rules that don't depend on a clock or a database.
 *
 * Planning horizon: a task may be planned for any local date from today through
 * today + 365 days, INCLUSIVE — that is 366 allowed calendar dates (offset 0 … 365). There is
 * no past-day planning.
 */

export const PLANNING_HORIZON_DAYS = 365;

/** A task may last at most 24 hours (and must still start inside its planning day). */
export const MAX_TASK_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_TASK_DURATION_MINUTES = 24 * 60;
export const MIN_TASK_DURATION_MINUTES = 5;

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(localDate: string): boolean {
  if (!LOCAL_DATE.test(localDate)) return false;
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** `localDate` moved by `n` calendar days (negative allowed); pure calendar arithmetic. */
export function addDays(localDate: string, n: number): string {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The last plannable date given today's local date. */
export function lastPlanningDate(todayLocal: string): string {
  return addDays(todayLocal, PLANNING_HORIZON_DAYS);
}

/** True for `todayLocal` … `todayLocal + 365` inclusive (366 dates), false for anything else,
 *  including malformed input and impossible dates like 2026-02-30. */
export function isPlanDateAllowed(date: string, todayLocal: string): boolean {
  if (!isRealDate(date) || !isRealDate(todayLocal)) return false;
  return date >= todayLocal && date <= lastPlanningDate(todayLocal); // ISO dates sort as text
}
