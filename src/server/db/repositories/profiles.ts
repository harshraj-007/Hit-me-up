import "server-only";
import { ExternalServiceError } from "@/server/errors";
import type { SupabaseServerClient } from "../supabase-server";

export interface Profile {
  id: string;
  timezone: string;
}

/**
 * The caller's profile, or `null` if the browser hasn't reported a timezone yet.
 *
 * A profile row exists *only* once a real timezone has been recorded (see `saveTimezone`), so
 * "no row" means "timezone unknown" — it deliberately does NOT get papered over with a
 * placeholder. Creating one on first read with the column default `'UTC'` is what used to let
 * the very first request file a `days` row under UTC before the browser had reported the
 * user's real zone, producing a second, differently-dated day one request later.
 */
export async function getProfile(
  supabase: SupabaseServerClient,
  userId: string,
): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, timezone")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return data;
}

/**
 * Records the timezone the browser reported, creating the profile if this is the first time.
 * This is INSERT ... ON CONFLICT DO UPDATE, which is fine here (unlike the append-only
 * plans/plan_revisions tables) because `profiles` has both an INSERT and an UPDATE RLS policy.
 */
export async function saveTimezone(
  supabase: SupabaseServerClient,
  userId: string,
  timezone: string,
): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .upsert({ id: userId, timezone }, { onConflict: "id" });
  if (error) throw new ExternalServiceError("supabase", { cause: error });
}
