import "server-only";
import { addDays, dayBoundsUtc, isPlanDateAllowed } from "@/domain/days";
import { requireUser } from "@/server/auth/session";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { listSpilloverTasks, listTasksForDay } from "@/server/db/repositories/tasks";
import { findPendingProposal } from "@/server/db/repositories/ai-proposals";
import { getLatestRevisionNumber } from "@/server/db/repositories/plans";
import { getLatestBriefing } from "@/server/db/repositories/briefings";
import type { Task } from "@/domain/tasks";
import type { EodReportView } from "@/domain/eod";
import type { AiProposal } from "@/server/db/repositories/ai-proposals";
import { findCurrentDay, todayLocalDate, viewDay } from "./day";
import { loadEodReportView } from "./eod-report";

export interface TodaySnapshot {
  kind: "ready";
  /** `today` is the live day; `future` is a planning day that hasn't started. */
  viewState: "today" | "future";
  /** Null only for a future date that has no day row yet (viewing never creates one). */
  dayId: string | null;
  localDate: string;
  /** Today's local date in the caller's profile timezone (the horizon and navigation anchor). */
  todayLocal: string;
  /** The caller's CURRENT profile timezone — what a not-yet-created day would be stamped with. */
  profileTimezone: string;
  /** The previous day's row, if any: the date and frozen timezone its spillover tasks are
   *  read and edited in (which can differ from this day's if the profile timezone changed). */
  previousDay: { localDate: string; timezone: string } | null;
  /** The day's own (frozen) timezone — the only zone its times are read or shown in. If the
   *  day has no row yet this is the profile timezone a new day would be created with. */
  timezone: string;
  /** Tasks whose planning day is this day. Progress is computed from these alone. */
  tasks: Task[];
  /** The previous day's unresolved tasks still running into this day (cross-midnight). They
   *  stay the previous day's tasks: shown and planned around here, never counted here. */
  spillover: Task[];
  briefingText: string | null;
  /** This day's pending (unconfirmed) AI proposal, if any (Phase 5.5) — enough to resume the
   *  review UI after a refresh with no AI call. `isStale` compares its base revision against
   *  this same read's `tasks`/plan state; it is a live comparison, never itself persisted. */
  pendingAiProposal: { proposal: AiProposal; isStale: boolean } | null;
  /** Today's end-of-day review, if one was written (Phase 7), and whether the day has changed
   *  since — read only, no model call. Always null for a future day: only today can be reviewed. */
  eodReport: EodReportView | null;
  /** The instant this snapshot was computed — the shared clock's starting point. */
  now: Date;
}

/** The user's timezone isn't known yet (first visit): nothing has been created, and the page
 *  should have the browser report it and then re-render. */
export interface TodayNeedsTimezone {
  kind: "needs-timezone";
}

/** The requested `?date=` is malformed or outside today … today + 365; go back to today. */
export interface TodayInvalidDate {
  kind: "invalid-date";
}

/**
 * Everything the Today page needs, in a small, fixed number of round trips (no per-task
 * queries). With no `requestedDate` (or today's date) it resolves today through ensure_day,
 * which also guarantees the plan. For a future date it only READS: the day may not exist yet,
 * and merely looking at a date must not create it. Returns `needs-timezone` — creating
 * nothing — before the browser has reported a timezone, and `invalid-date` for a date outside
 * the planning horizon.
 */
export async function getTodaySnapshot(
  requestedDate?: string,
): Promise<TodaySnapshot | TodayNeedsTimezone | TodayInvalidDate> {
  const user = await requireUser();
  const supabase = await createSupabaseServerClient();
  const now = new Date();

  const clock = await todayLocalDate(supabase, user.id);
  if (!clock) return { kind: "needs-timezone" };
  const { todayLocal, profileTimezone } = clock;

  const wanted = requestedDate ?? todayLocal;
  if (!isPlanDateAllowed(wanted, todayLocal)) return { kind: "invalid-date" };
  const viewState = wanted === todayLocal ? "today" : "future";

  const day =
    viewState === "today"
      ? await findCurrentDay(supabase, user.id)
      : await viewDay(supabase, user.id, wanted);
  if (viewState === "today" && !day) return { kind: "needs-timezone" };

  const timezone = day?.timezone ?? profileTimezone;
  const localDate = day?.localDate ?? wanted;
  const dayStart = dayBoundsUtc(localDate, timezone).start;

  const previous = await viewDay(supabase, user.id, addDays(localDate, -1));
  const [tasks, spillover, briefing, pendingProposal, currentRevision] = await Promise.all([
    day ? listTasksForDay(supabase, day.id) : Promise.resolve([]),
    previous ? listSpilloverTasks(supabase, previous.id, dayStart) : Promise.resolve([]),
    viewState === "today" && day ? getLatestBriefing(supabase, day.id) : Promise.resolve(null),
    day ? findPendingProposal(supabase, day.id) : Promise.resolve(null),
    day ? getLatestRevisionNumber(supabase, day.id) : Promise.resolve(null),
  ]);

  // Only today is reviewable; the tasks are the ones just read, so staleness costs no extra read.
  const eodReport =
    viewState === "today" && day ? await loadEodReportView(supabase, day.id, tasks) : null;

  return {
    kind: "ready",
    viewState,
    todayLocal,
    profileTimezone,
    previousDay: previous ? { localDate: previous.localDate, timezone: previous.timezone } : null,
    dayId: day?.id ?? null,
    localDate,
    pendingAiProposal: pendingProposal
      ? { proposal: pendingProposal, isStale: currentRevision !== pendingProposal.baseRevision }
      : null,
    timezone,
    tasks,
    spillover,
    briefingText: briefing?.rawText ?? null,
    eodReport,
    now,
  };
}
