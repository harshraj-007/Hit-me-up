/**
 * The real edges of a user's calendar day: local midnight → next local midnight, expressed
 * as UTC instants, plus wall-clock → instant conversion. Everything here takes an explicit
 * IANA timezone; nothing reads the browser's or the server's own zone.
 *
 * A day is 23, 24 or 25 hours long around DST changes, so it is never `start + 24h`.
 */

const PARTS_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = PARTS_FORMATTER_CACHE.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    PARTS_FORMATTER_CACHE.set(timezone, formatter);
  }
  return formatter;
}

/** Offset of `timezone` from UTC at the UTC instant `utcMs`, in ms (east of UTC is positive). */
function offsetAt(utcMs: number, timezone: string): number {
  const parts = partsFormatter(timezone).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)!.value);
  const wallAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return wallAsUtc - Math.floor(utcMs / 1000) * 1000;
}

const DAY_MS = 86_400_000;

export interface WallTime {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Local wall-clock time, `HH:mm`. */
  time: string;
  /** IANA timezone the wall clock belongs to. */
  timezone: string;
}

/**
 * The UTC instant at which the wall clock in `timezone` reads `date` `time`.
 *
 *  - An ordinary time maps to exactly one instant.
 *  - A time that does not exist (skipped by a spring-forward change, e.g. 02:30) moves
 *    FORWARD by the length of the gap, so 02:30 becomes 03:30.
 *  - A time that happens twice (repeated by a fall-back change, e.g. 01:30) resolves to its
 *    FIRST occurrence.
 *
 * This is also how local midnight is found, so days that begin inside a DST change (zones
 * that switch at 00:00) start at the first instant that actually exists on that date.
 */
export function wallTimeToUtc({ date, time, timezone }: WallTime): Date {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  const wall = Date.UTC(year, month - 1, day, hours, minutes);

  // The offsets in force a day before and a day after the wall time bracket any transition.
  const before = offsetAt(wall - DAY_MS, timezone);
  const after = offsetAt(wall + DAY_MS, timezone);

  const valid = [...new Set([before, after])]
    .map((offset) => ({ offset, instant: wall - offset }))
    .filter(({ offset, instant }) => offsetAt(instant, timezone) === offset)
    .map(({ instant }) => instant);

  if (valid.length > 0) return new Date(Math.min(...valid)); // 1 = ordinary, 2 = repeated
  return new Date(wall - before); // nonexistent: apply the pre-transition offset → moves forward
}

/** The UTC instant at which `localDate` (YYYY-MM-DD) begins in `timezone`. */
export function localMidnightUtc(localDate: string, timezone: string): Date {
  return wallTimeToUtc({ date: localDate, time: "00:00", timezone });
}

function nextLocalDate(localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

export interface DayBounds {
  /** Inclusive. */
  start: Date;
  /** Exclusive: the start of the next local day. */
  end: Date;
}

export function dayBoundsUtc(localDate: string, timezone: string): DayBounds {
  return {
    start: localMidnightUtc(localDate, timezone),
    end: localMidnightUtc(nextLocalDate(localDate), timezone),
  };
}
