import "server-only";
import { resolveLocalDate } from "@/domain/days";
import { getProfile } from "@/server/db/repositories/profiles";
import { getOrCreateDay, type Day } from "@/server/db/repositories/days";
import type { SupabaseServerClient } from "@/server/db/supabase-server";
import { ValidationError } from "@/server/errors";

/**
 * Resolves "today" for the caller, server-side, every time — never from a client-supplied
 * date or a day id cached from an earlier page load. That matters across a real midnight
 * rollover: if a session stays open past local midnight, the next mutation should file
 * under the new day, not silently keep writing into yesterday's.
 *
 * Returns `null`, and creates NOTHING, while the user's timezone is still unknown (no profile
 * row yet — the browser reports it right after the first page loads). Computing "today" in a
 * guessed timezone and persisting it is exactly what used to leave a stray `days` row dated
 * in UTC when the user's real date was different.
 */
export async function findCurrentDay(
  supabase: SupabaseServerClient,
  userId: string,
): Promise<Day | null> {
  const profile = await getProfile(supabase, userId);
  if (!profile) return null;
  const localDate = resolveLocalDate(new Date(), profile.timezone);
  return getOrCreateDay(supabase, userId, localDate, profile.timezone);
}

/** For mutations, which have no sensible way to proceed without a day. */
export async function resolveCurrentDay(
  supabase: SupabaseServerClient,
  userId: string,
): Promise<Day> {
  const day = await findCurrentDay(supabase, userId);
  if (!day) {
    throw new ValidationError([
      { path: "timezone", message: "Still setting up your timezone — please try again." },
    ]);
  }
  return day;
}
