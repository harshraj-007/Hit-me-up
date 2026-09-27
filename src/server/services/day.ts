import "server-only";
import { isPlanDateAllowed, resolveLocalDate } from "@/domain/days";
import { getProfile } from "@/server/db/repositories/profiles";
import { ensureDay, findDayByDate, type Day } from "@/server/db/repositories/days";
import type { SupabaseServerClient } from "@/server/db/supabase-server";
import { ValidationError } from "@/server/errors";

const NEEDS_TIMEZONE = [
  { path: "timezone", message: "Still setting up your timezone — please try again." },
];

/**
 * Resolves "today" for the caller, server-side, every time — never from a client-supplied
 * date or a cached day id (so a session that crosses real midnight starts using the new day).
 *
 * Returns `null`, and creates NOTHING, while the user's timezone is still unknown (no profile
 * row yet — the browser reports it right after the first page loads). That check runs BEFORE
 * ensure_day, so a request that arrives ahead of the timezone report can never file a day
 * under a guessed zone. Once the profile exists, ensure_day() resolves today from the profile
 * timezone in SQL and creates the day, its plan and revision 1 (idempotently). An existing
 * day keeps the timezone it was created with: it is frozen, not re-read from the profile.
 */
export async function findCurrentDay(
  supabase: SupabaseServerClient,
  userId: string,
): Promise<Day | null> {
  const profile = await getProfile(supabase, userId);
  if (!profile) return null;
  return ensureDay(supabase);
}

/** For mutations, which have no sensible way to proceed without a day. */
export async function resolveCurrentDay(
  supabase: SupabaseServerClient,
  userId: string,
): Promise<Day> {
  const day = await findCurrentDay(supabase, userId);
  if (!day) throw new ValidationError(NEEDS_TIMEZONE);
  return day;
}

/** Today's local date in the caller's profile timezone, or null while it is unknown. */
export async function todayLocalDate(
  supabase: SupabaseServerClient,
  userId: string,
): Promise<{ todayLocal: string; profileTimezone: string } | null> {
  const profile = await getProfile(supabase, userId);
  if (!profile) return null;
  return {
    todayLocal: resolveLocalDate(new Date(), profile.timezone),
    profileTimezone: profile.timezone,
  };
}

const OUT_OF_HORIZON = [
  { path: "planningDate", message: "Pick a date from today up to a year ahead." },
];

/**
 * The day for an explicit planning date, CREATED if needed (via ensure_day). Used by actions
 * that need the day to exist — adding a task to a future day. The date must lie in
 * today … today + 365 (inclusive); the client names only a date, never a day id.
 */
export async function resolveDayForDate(
  supabase: SupabaseServerClient,
  userId: string,
  localDate: string,
): Promise<Day> {
  const today = await todayLocalDate(supabase, userId);
  if (!today) throw new ValidationError(NEEDS_TIMEZONE);
  if (!isPlanDateAllowed(localDate, today.todayLocal)) throw new ValidationError(OUT_OF_HORIZON);
  return ensureDay(supabase, localDate);
}

/**
 * The day for a date, READ-ONLY: null if it has no row yet. Viewing a future date never
 * creates a day — only an action that needs one does.
 */
export async function viewDay(
  supabase: SupabaseServerClient,
  userId: string,
  localDate: string,
): Promise<Day | null> {
  return findDayByDate(supabase, userId, localDate);
}
