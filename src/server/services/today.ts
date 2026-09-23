import "server-only";
import { requireUser } from "@/server/auth/session";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { ensurePlan } from "@/server/db/repositories/plans";
import { listTasksForDay } from "@/server/db/repositories/tasks";
import { getLatestBriefing } from "@/server/db/repositories/briefings";
import type { Task } from "@/domain/tasks";
import { resolveCurrentDay } from "./day";

export interface TodaySnapshot {
  dayId: string;
  localDate: string;
  tasks: Task[];
  briefingText: string | null;
  /** The instant this snapshot was computed — used to derive "current" status once, here,
   *  rather than continuously client-side (see domain/tasks/derive-status.ts). */
  now: Date;
}

/**
 * Everything the Today page needs, in a small, fixed number of round trips: ensure
 * profile -> ensure day -> ensure plan -> (tasks, briefing) in parallel. No per-task
 * queries, so this doesn't grow with how many tasks a day has.
 */
export async function getTodaySnapshot(): Promise<TodaySnapshot> {
  const user = await requireUser();
  const supabase = await createSupabaseServerClient();
  const now = new Date();

  const day = await resolveCurrentDay(supabase, user.id);
  await ensurePlan(supabase, user.id, day.id);

  const [tasks, briefing] = await Promise.all([
    listTasksForDay(supabase, day.id),
    getLatestBriefing(supabase, day.id),
  ]);

  return {
    dayId: day.id,
    localDate: day.localDate,
    tasks,
    briefingText: briefing?.rawText ?? null,
    now,
  };
}
