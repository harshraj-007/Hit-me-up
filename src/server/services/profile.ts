import "server-only";
import { requireUserForAction } from "@/server/auth/session";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { ensureProfile, updateTimezone } from "@/server/db/repositories/profiles";
import { isValidTimeZone } from "@/domain/days";
import { timezoneSchema } from "@/lib/validation/day";
import { ValidationError } from "@/server/errors";

/**
 * The one-time (per browser, effectively) timezone capture described in
 * domain/days/timezone.ts: the client reports `Intl.DateTimeFormat().resolvedOptions().timeZone`
 * once, this records it, and every later "what's today" computation uses it. Silently
 * ignores a timezone matching what's already stored, so this is safe to call on every page
 * load without writing on every request.
 */
export async function syncTimezone(rawInput: unknown): Promise<void> {
  const user = await requireUserForAction();
  const timezone = timezoneSchema.parse(rawInput);
  if (!isValidTimeZone(timezone)) {
    throw new ValidationError([{ path: "timezone", message: "Not a recognized timezone." }]);
  }

  const supabase = await createSupabaseServerClient();
  const profile = await ensureProfile(supabase, user.id);
  if (profile.timezone === timezone) return;

  await updateTimezone(supabase, user.id, timezone);
}
