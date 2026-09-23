/**
 * Timezone strategy (Phase 3): every user has a `profiles.timezone` IANA name, defaulting
 * to "UTC" until the client reports the browser's actual zone once per session (see
 * src/features/settings/timezone-sync.tsx). "Today" is never computed with
 * `new Date().toISOString().slice(0, 10)` — that's always UTC's calendar date, which is
 * wrong for most users most of the day. Deliberately out of scope: a settings UI to change
 * timezone by hand — the one-time browser sync is the whole Phase 3 mechanism.
 *
 * Uses `Intl.DateTimeFormat` (built into Node/browsers) rather than adding a date-fns
 * timezone package — one IANA-aware calendar-date computation doesn't justify a new
 * dependency.
 */

const DAY_KEY_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = DAY_KEY_FORMATTER_CACHE.get(timezone);
  if (!formatter) {
    // en-CA formats as YYYY-MM-DD, exactly the identity key `days.local_date` needs.
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    DAY_KEY_FORMATTER_CACHE.set(timezone, formatter);
  }
  return formatter;
}

/** Returns the calendar date (YYYY-MM-DD) `instant` falls on in `timezone`. */
export function resolveLocalDate(instant: Date, timezone: string): string {
  return getFormatter(timezone).format(instant);
}

/** True if `timezone` is a name `Intl` actually recognizes (rejects free-form garbage). */
export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
