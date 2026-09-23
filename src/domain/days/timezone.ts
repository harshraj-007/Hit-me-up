/**
 * Timezone strategy: a user's `profiles.timezone` (IANA name) is reported by their browser —
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` — and a profile row exists ONLY once
 * that has happened. Until then the server knows the user's timezone is unknown and creates
 * no day (see src/server/services/day.ts `findCurrentDay`); it never guesses one. "Today" is
 * then the calendar date in that zone, never `new Date().toISOString().slice(0, 10)`, which is
 * always UTC's date and wrong for most users for hours of every day. Deliberately out of
 * scope: a settings UI to change timezone by hand.
 *
 * The browser side lives in src/components/layout/timezone-setup.tsx (first visit) and
 * timezone-sync.tsx (later changes, e.g. travel).
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
