import "server-only";
import { ExternalServiceError } from "@/server/errors";
import type { SupabaseServerClient } from "../supabase-server";
import { findPlan } from "./plans";

/**
 * Read-only: the revision numbers of a day's plan, oldest first (empty if the day has no plan).
 * Revisions are created only by ensure_day()/reschedule_task()/apply_replan()/the AI confirm
 * path; the end-of-day review only counts them ("how many times did the plan change").
 */
export async function listRevisionNumbers(
  supabase: SupabaseServerClient,
  dayId: string,
): Promise<{ revisionNumber: number }[]> {
  const plan = await findPlan(supabase, dayId);
  if (!plan) return [];
  const { data, error } = await supabase
    .from("plan_revisions")
    .select("revision_number")
    .eq("plan_id", plan.id)
    .order("revision_number", { ascending: true });
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return data.map((r) => ({ revisionNumber: r.revision_number }));
}
