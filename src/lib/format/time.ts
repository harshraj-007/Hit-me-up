import { differenceInMinutes, format, isSameDay, isWithinInterval } from "date-fns";

/** "9:30 AM" */
export function formatClock(date: Date): string {
  return format(date, "h:mm a");
}

/** "9:30 – 10:15 AM" (drops the repeated am/pm when both ends share it) */
export function formatRange(start: Date, end: Date): string {
  const startLabel = format(start, "h:mm a");
  const endLabel = format(end, "h:mm a");
  const [, startPeriod] = startLabel.split(" ");
  const [, endPeriod] = endLabel.split(" ");
  if (startPeriod === endPeriod) {
    return `${startLabel.replace(` ${startPeriod}`, "")} – ${endLabel}`;
  }
  return `${startLabel} – ${endLabel}`;
}

/** "1h 30m" / "45m" */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

export function minutesBetween(start: Date, end: Date): number {
  return differenceInMinutes(end, start);
}

export function isNow(start: Date, end: Date, now: Date): boolean {
  return isWithinInterval(now, { start, end });
}

export function isToday(date: Date, now: Date): boolean {
  return isSameDay(date, now);
}

/** "Monday, September 22" */
export function formatDayHeading(date: Date): string {
  return format(date, "EEEE, MMMM d");
}
