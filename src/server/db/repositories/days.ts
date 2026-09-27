import "server-only";
import { ExternalServiceError, ValidationError } from "@/server/errors";
import type { SupabaseServerClient } from "../supabase-server";

export interface Day {
  id: string;
  userId: string;
  localDate: string;
  timezone: string;
}

type DayRow = { id: string; user_id: string; local_date: string; timezone: string };

function mapDay(row: DayRow): Day {
  return { id: row.id, userId: row.user_id, localDate: row.local_date, timezone: row.timezone };
}

/** PL/pgSQL `no_data_found` — ensure_day() raises it when the caller has no profile yet. */
const NO_PROFILE = "P0002";
/** `invalid_parameter_value` — a date outside the planning horizon, or a timezone Postgres
 *  doesn't know. */
const INVALID_PARAMETER = "22023";

/**
 * Gets-or-creates the caller's day — and its plan and revision 1 — through the ensure_day()
 * RPC, the ONLY way a day comes into existence. `localDate` is a plain calendar date
 * (omitted = today, resolved in SQL from the caller's profile timezone); the owner and the
 * day's timezone always come from the session/profile, never from here. An existing day's
 * timezone is never changed: it is frozen when the row is created.
 */
export async function ensureDay(supabase: SupabaseServerClient, localDate?: string): Promise<Day> {
  const { data, error } = await supabase.rpc("ensure_day", { p_local_date: localDate ?? null });
  if (error) {
    if (error.code === NO_PROFILE) {
      throw new ValidationError(
        [{ path: "timezone", message: "Still setting up your timezone — please try again." }],
        { cause: error },
      );
    }
    if (error.code === INVALID_PARAMETER) {
      throw new ValidationError(
        [{ path: "planningDate", message: "That date isn't available for planning." }],
        { cause: error },
      );
    }
    throw new ExternalServiceError("supabase", { cause: error });
  }
  return mapDay(data);
}

/** Read-only: the caller's day for `localDate`, or null if none exists yet. Creates nothing. */
export async function findDayByDate(
  supabase: SupabaseServerClient,
  userId: string,
  localDate: string,
): Promise<Day | null> {
  const { data, error } = await supabase
    .from("days")
    .select("id, user_id, local_date, timezone")
    .eq("user_id", userId)
    .eq("local_date", localDate)
    .maybeSingle();
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return data ? mapDay(data) : null;
}

/** Read-only: a day by id. RLS hides other users' days, so a foreign id is simply null. */
export async function findDayById(
  supabase: SupabaseServerClient,
  dayId: string,
): Promise<Day | null> {
  const { data, error } = await supabase
    .from("days")
    .select("id, user_id, local_date, timezone")
    .eq("id", dayId)
    .maybeSingle();
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return data ? mapDay(data) : null;
}
