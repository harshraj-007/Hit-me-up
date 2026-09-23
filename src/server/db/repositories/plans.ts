import "server-only";
import { ExternalServiceError } from "@/server/errors";
import type { SupabaseServerClient } from "../supabase-server";

export interface Plan {
  id: string;
  dayId: string;
}

async function findPlan(supabase: SupabaseServerClient, dayId: string): Promise<Plan | null> {
  const { data, error } = await supabase
    .from("plans")
    .select("id, day_id")
    .eq("day_id", dayId)
    .maybeSingle();
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return data ? { id: data.id, dayId: data.day_id } : null;
}

/**
 * Gets-or-creates the single plan for a day, plus its initial revision, establishing the
 * Day -> Plan -> Revisions chain a future AI-replanning phase will extend (see the schema
 * comment on `public.plans` in the migration). Nothing reads plans/plan_revisions yet in
 * this phase — this exists purely to make that chain real and idempotent from day one.
 *
 * Read first, write only what's missing, and never with `ON CONFLICT DO UPDATE`: `plans` and
 * `plan_revisions` are append-only and deliberately have no UPDATE RLS policy, so a plain
 * `.upsert({ onConflict })` (which is DO UPDATE) is denied the moment the row already exists —
 * that was the refresh-time `42501 ... (USING expression) for table "plans"` failure. Races
 * are handled by `ignoreDuplicates` (DO NOTHING) plus the unique constraints
 * (`plans_day_unique`, `plan_revisions_number_unique`), which remain the real guard. A
 * steady-state page load performs two reads and no writes.
 */
export async function ensurePlan(
  supabase: SupabaseServerClient,
  userId: string,
  dayId: string,
): Promise<Plan> {
  let plan = await findPlan(supabase, dayId);

  if (!plan) {
    const { error } = await supabase
      .from("plans")
      .upsert({ user_id: userId, day_id: dayId }, { onConflict: "day_id", ignoreDuplicates: true });
    if (error) throw new ExternalServiceError("supabase", { cause: error });

    // Re-read rather than trusting the write's return: under DO NOTHING a lost race returns
    // no row, and the winner's row is the canonical one either way.
    plan = await findPlan(supabase, dayId);
    if (!plan) {
      throw new ExternalServiceError("supabase", {
        cause: new Error("plan missing immediately after insert"),
      });
    }
  }

  await ensureInitialRevision(supabase, userId, plan.id);
  return plan;
}

async function ensureInitialRevision(
  supabase: SupabaseServerClient,
  userId: string,
  planId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("plan_revisions")
    .select("id")
    .eq("plan_id", planId)
    .limit(1)
    .maybeSingle();
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  if (data) return;

  // Also covers a plan left without a revision by an earlier partial failure.
  const { error: insertError } = await supabase
    .from("plan_revisions")
    .upsert(
      { plan_id: planId, user_id: userId, revision_number: 1, source: "system" },
      { onConflict: "plan_id,revision_number", ignoreDuplicates: true },
    );
  if (insertError) throw new ExternalServiceError("supabase", { cause: insertError });
}
