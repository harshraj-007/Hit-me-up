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

/**
 * Read-only: the newest revision number of a day's plan, or `null` if the day has no plan or no
 * revision. Used to stamp an AI planning context with the revision it was computed from.
 */
export async function getLatestRevisionNumber(
  supabase: SupabaseServerClient,
  dayId: string,
): Promise<number | null> {
  const plan = await findPlan(supabase, dayId);
  if (!plan) return null;
  const { data, error } = await supabase
    .from("plan_revisions")
    .select("revision_number")
    .eq("plan_id", plan.id)
    .order("revision_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return data ? data.revision_number : null;
}
