import "server-only";
import { requireUser } from "@/server/auth/session";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { ensurePlan } from "@/server/db/repositories/plans";
import { listTasksForDay } from "@/server/db/repositories/tasks";
import { getLatestBriefing } from "@/server/db/repositories/briefings";
import type { Task } from "@/domain/tasks";
import { findCurrentDay } from "./day";

export interface TodaySnapshot {
  kind: "ready";
  dayId: string;
  localDate: string;
  tasks: Task[];
  briefingText: string | null;
  /** The instant this snapshot was computed — used to derive "current" status once, here,
   *  rather than continuously client-side (see domain/tasks/derive-status.ts). */
  now: Date;
}

/** The user's timezone isn't known yet (first visit): nothing has been created, and the page
 *  should have the browser report it and then re-render. */
export interface TodayNeedsTimezone {
  kind: "needs-timezone";
}

/**
 * Everything the Today page needs, in a small, fixed number of round trips: read profile ->
 * ensure day -> ensure plan -> (tasks, briefing) in parallel. No per-task queries, so this
 * doesn't grow with how many tasks a day has. Returns `needs-timezone` — creating no day,
 * plan or revision — when the browser hasn't reported a timezone yet.
 */
export async function getTodaySnapshot(): Promise<TodaySnapshot | TodayNeedsTimezone> {
  const user = await requireUser();
  const supabase = await createSupabaseServerClient();
  const now = new Date();

  const day = await findCurrentDay(supabase, user.id);
  if (!day) return { kind: "needs-timezone" };
  await ensurePlan(supabase, user.id, day.id);

  const [tasks, briefing] = await Promise.all([
    listTasksForDay(supabase, day.id),
    getLatestBriefing(supabase, day.id),
  ]);

  return {
    kind: "ready",
    dayId: day.id,
    localDate: day.localDate,
    tasks,
    briefingText: briefing?.rawText ?? null,
    now,
  };
}
