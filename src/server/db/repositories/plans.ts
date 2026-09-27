import "server-only";
import { ExternalServiceError } from "@/server/errors";
import type { SupabaseServerClient } from "../supabase-server";

export interface Plan {
  id: string;
  dayId: string;
}

/**
 * Read-only. A day's plan and its initial revision are created by the ensure_day() RPC along
 * with the day itself (see the repositories/days.ts `ensureDay`); plan revisions after that are
 * appended only by reschedule_task() and apply_replan(). The application no longer writes
 * `plans` or `plan_revisions` directly.
 */
export async function findPlan(
  supabase: SupabaseServerClient,
  dayId: string,
): Promise<Plan | null> {
  const { data, error } = await supabase
    .from("plans")
    .select("id, day_id")
    .eq("day_id", dayId)
    .maybeSingle();
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return data ? { id: data.id, dayId: data.day_id } : null;
}
