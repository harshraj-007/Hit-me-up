import "server-only";
import { ExternalServiceError } from "@/server/errors";
import type { SupabaseServerClient } from "../supabase-server";

export interface Day {
  id: string;
  userId: string;
  localDate: string;
  timezone: string;
}

function mapDay(row: { id: string; user_id: string; local_date: string; timezone: string }): Day {
  return { id: row.id, userId: row.user_id, localDate: row.local_date, timezone: row.timezone };
}

/**
 * Gets-or-creates the caller's Day for `localDate`. Idempotent by construction: the
 * `days_user_date_unique` constraint (see the Phase 3 migration) is the real guard, not
 * this function — an upsert on that constraint always returns the one canonical row for
 * (user, date), whether this call created it or a concurrent one already had.
 */
export async function getOrCreateDay(
  supabase: SupabaseServerClient,
  userId: string,
  localDate: string,
  timezone: string,
): Promise<Day> {
  const { data, error } = await supabase
    .from("days")
    .upsert(
      { user_id: userId, local_date: localDate, timezone },
      { onConflict: "user_id,local_date" },
    )
    .select("id, user_id, local_date, timezone")
    .single();

  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return mapDay(data);
}
