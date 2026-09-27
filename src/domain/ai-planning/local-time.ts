import { wallTimeToUtc } from "@/domain/days";

/**
 * The AI-facing time format: local wall-clock `YYYY-MM-DDTHH:mm` in the planning day's own
 * (frozen) timezone. Local times are what people say and what a model handles reliably; the
 * conversion back to an instant goes through the existing `wallTimeToUtc`, so DST gaps and
 * repeats resolve exactly as they do everywhere else in the app.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    FORMATTERS.set(timezone, f);
  }
  return f;
}

export function formatLocalWallTime(instant: Date, timezone: string): string {
  const parts = formatter(timezone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

const LOCAL_WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** The instant for a model-supplied local wall time, or `null` if the string is not a real one. */
export function parseLocalWallTime(value: string, timezone: string): Date | null {
  const match = LOCAL_WALL_TIME.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  if (h > 23 || mi > 59) return null;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return null; // e.g. 2026-02-30
  }
  const instant = wallTimeToUtc({
    date: `${match[1]}-${match[2]}-${match[3]}`,
    time: `${match[4]}:${match[5]}`,
    timezone,
  });
  return Number.isFinite(instant.getTime()) ? instant : null;
}
