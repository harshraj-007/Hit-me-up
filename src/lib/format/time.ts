/**
 * Display formatting. Every function that renders a moment takes an explicit IANA `timezone`
 * (a planning day's own `days.timezone`); nothing here reads the browser's zone. Built on
 * `Intl` so no timezone package is needed.
 */

const CACHE = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string, key: string, options: Intl.DateTimeFormatOptions) {
  const id = `${timezone}|${key}`;
  let f = CACHE.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, ...options });
    CACHE.set(id, f);
  }
  return f;
}

function parts(date: Date, timezone: string, key: string, options: Intl.DateTimeFormatOptions) {
  const map: Record<string, string> = {};
  for (const p of formatter(timezone, key, options).formatToParts(date)) map[p.type] = p.value;
  return map;
}

const CLOCK = { hour: "numeric", minute: "2-digit", hour12: true } as const;

/** "9:30 AM" — always a plain space before AM/PM (newer ICU uses a narrow no-break space). */
export function formatClock(date: Date, timezone: string): string {
  const p = parts(date, timezone, "clock", CLOCK);
  return `${p.hour}:${p.minute} ${(p.dayPeriod ?? "").toUpperCase()}`;
}

/** The local calendar date (YYYY-MM-DD) `date` falls on in `timezone`. */
export function localDateOf(date: Date, timezone: string): string {
  const p = parts(date, timezone, "ymd", { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
}

/** "9:30 – 10:15 AM" (drops the repeated am/pm when both ends share it). */
export function formatRange(start: Date, end: Date, timezone: string): string {
  const startLabel = formatClock(start, timezone);
  const endLabel = formatClock(end, timezone);
  const startPeriod = startLabel.split(" ")[1];
  const endPeriod = endLabel.split(" ")[1];
  if (startPeriod === endPeriod) {
    return `${startLabel.replace(` ${startPeriod}`, "")} – ${endLabel}`;
  }
  return `${startLabel} – ${endLabel}`;
}

/** True when `end` is on a later local calendar date than `start` in `timezone`. */
export function crossesMidnight(start: Date, end: Date, timezone: string): boolean {
  return localDateOf(end, timezone) > localDateOf(start, timezone);
}

/**
 * A task's window as shown in the timeline: `formatRange`, plus " +1 day" when the end falls
 * on the calendar date AFTER the start's (in `timezone`) — e.g. "11:30 PM – 1:00 AM +1 day".
 */
export function formatWindow(start: Date, end: Date, timezone: string): string {
  return `${formatRange(start, end, timezone)}${crossesMidnight(start, end, timezone) ? " +1 day" : ""}`;
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
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

/** "Monday, September 22" for the instant `date`, as seen in `timezone`. */
export function formatDayHeading(date: Date, timezone: string): string {
  const p = parts(date, timezone, "heading", { weekday: "long", month: "long", day: "numeric" });
  return `${p.weekday}, ${p.month} ${p.day}`;
}

/** "Fri 26 Sep" for a local calendar date (YYYY-MM-DD) — pure calendar, no timezone involved. */
export function formatPlanningDate(localDate: string): string {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  const p = parts(new Date(Date.UTC(y, m - 1, d)), "UTC", "planning", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** The hour (0–23) on the wall clock of `timezone` at `date`. */
export function localHour(date: Date, timezone: string): number {
  return Number(parts(date, timezone, "hour24", { hour: "numeric", hourCycle: "h23" }).hour) % 24;
}

/** "HH:mm" 24-hour wall time in `timezone` (the value format of `<input type="time">`). */
export function formatTimeInput(date: Date, timezone: string): string {
  const p = parts(date, timezone, "time24", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${p.hour!.padStart(2, "0")}:${p.minute}`;
}
