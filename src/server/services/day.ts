import "server-only";
import { resolveLocalDate } from "@/domain/days";
import { ensureProfile } from "@/server/db/repositories/profiles";
import { getOrCreateDay, type Day } from "@/server/db/repositories/days";
import type { SupabaseServerClient } from "@/server/db/supabase-server";

/**
 * Resolves "today" for the caller, server-side, every time — never from a client-supplied
 * date or a day id cached from an earlier page load. That matters across a real midnight
 * rollover: if a session stays open past local midnight, the next mutation should file
 * under the new day, not silently keep writing into yesterday's.
 */
export async function resolveCurrentDay(
  supabase: SupabaseServerClient,
  userId: string,
): Promise<Day> {
  const profile = await ensureProfile(supabase, userId);
  const localDate = resolveLocalDate(new Date(), profile.timezone);
  return getOrCreateDay(supabase, userId, localDate, profile.timezone);
}
