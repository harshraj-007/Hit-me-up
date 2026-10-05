import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TimezoneSetup } from "@/components/layout/timezone-setup";
import { DashboardView } from "@/features/dashboard/dashboard-view";
import { proposalViewFromPersisted } from "@/features/dashboard/ai-planning/proposal-view";
import { getTodaySnapshot } from "@/server/services/today";

export const metadata: Metadata = { title: "Today" };

// Always current data: task/briefing actions call revalidatePath("/today"), but this page
// also depends on wall-clock time (which task is "current" right now) that revalidation
// alone wouldn't catch.
export const dynamic = "force-dynamic";

/**
 * `?date=YYYY-MM-DD` selects a planning day from today through today + 365. Anything else —
 * malformed, impossible, in the past, beyond the horizon, or repeated — redirects to today.
 * The query value only ever names a calendar date; the day itself is resolved server-side.
 *
 * A database failure here (or anywhere requireUser()/the repositories throw) is caught by
 * the nearest error boundary — src/app/(app)/error.tsx — automatically; there is
 * deliberately no try/catch in this file. An empty day/task list is handled by
 * TodayTimeline's own empty state, not here.
 *
 * On a user's first visit the server doesn't know their timezone yet and creates no day; it
 * returns `needs-timezone`, and TimezoneSetup reports the browser's zone and refreshes.
 */
export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string | string[] }>;
}) {
  const { date } = await searchParams;
  if (Array.isArray(date)) redirect("/today");

  const snapshot = await getTodaySnapshot(date);
  if (snapshot.kind === "needs-timezone") return <TimezoneSetup />;
  if (snapshot.kind === "invalid-date") redirect("/today");

  return (
    <DashboardView
      // A different day is a different set of tasks: remount so no state leaks across days.
      key={snapshot.localDate}
      viewState={snapshot.viewState}
      dayId={snapshot.dayId}
      localDate={snapshot.localDate}
      todayLocal={snapshot.todayLocal}
      timezone={snapshot.timezone}
      profileTimezone={snapshot.profileTimezone}
      previousDay={snapshot.previousDay}
      initialTasks={snapshot.tasks}
      initialSpillover={snapshot.spillover}
      initialBriefingText={snapshot.briefingText ?? ""}
      initialNow={snapshot.now}
      initialPendingAiProposal={
        snapshot.pendingAiProposal
          ? proposalViewFromPersisted(
              snapshot.pendingAiProposal.proposal,
              snapshot.pendingAiProposal.isStale,
            )
          : null
      }
      initialEodReport={snapshot.eodReport}
    />
  );
}
