import "server-only";
import { requireUserForAction } from "@/server/auth/session";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { getProfile, saveTimezone } from "@/server/db/repositories/profiles";
import { isValidTimeZone } from "@/domain/days";
import { timezoneSchema } from "@/lib/validation/day";
import { ValidationError } from "@/server/errors";

/**
 * Records the timezone the browser reports — and is the ONLY thing that creates a profile, so
 * a profile row's existence means "timezone confirmed by a real browser". `findCurrentDay`
 * relies on that: until this has run, no day is created at all. Skips the write when the
 * stored value already matches, so it is safe to call on every page load.
 */
export async function syncTimezone(rawInput: unknown): Promise<void> {
  const user = await requireUserForAction();
  const timezone = timezoneSchema.parse(rawInput);
  if (!isValidTimeZone(timezone)) {
    throw new ValidationError([{ path: "timezone", message: "Not a recognized timezone." }]);
  }

  const supabase = await createSupabaseServerClient();
  const profile = await getProfile(supabase, user.id);
  if (profile?.timezone === timezone) return;

  await saveTimezone(supabase, user.id, timezone);
}
