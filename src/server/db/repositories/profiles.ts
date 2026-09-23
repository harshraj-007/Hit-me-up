import "server-only";
import { ExternalServiceError } from "@/server/errors";
import type { SupabaseServerClient } from "../supabase-server";

export interface Profile {
  id: string;
  timezone: string;
}

/**
 * Gets the caller's profile, creating one (default timezone "UTC") the first time they're
 * seen. `ignoreDuplicates` makes this safe under concurrent requests — the second racer's
 * insert is silently skipped by the unique primary key, and both then read the same row.
 */
export async function ensureProfile(
  supabase: SupabaseServerClient,
  userId: string,
): Promise<Profile> {
  const inserted = await supabase
    .from("profiles")
    .upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true })
    .select("id, timezone")
    .maybeSingle();

  if (inserted.data) return inserted.data;
  if (inserted.error) {
    // A concurrent insert can make the upsert itself return no row under ignoreDuplicates
    // without an error; only a real error path lands here.
    throw new ExternalServiceError("supabase", { cause: inserted.error });
  }

  const existing = await supabase.from("profiles").select("id, timezone").eq("id", userId).single();
  if (existing.error) throw new ExternalServiceError("supabase", { cause: existing.error });
  return existing.data;
}

export async function updateTimezone(
  supabase: SupabaseServerClient,
  userId: string,
  timezone: string,
): Promise<void> {
  const { error } = await supabase.from("profiles").update({ timezone }).eq("id", userId);
  if (error) throw new ExternalServiceError("supabase", { cause: error });
}
