import type { Metadata } from "next";
import { TimezoneSetup } from "@/components/layout/timezone-setup";
import { DashboardView } from "@/features/dashboard/dashboard-view";
import { getTodaySnapshot } from "@/server/services/today";

export const metadata: Metadata = { title: "Today" };

// Always current data: task/briefing actions call revalidatePath("/today"), but this page
// also depends on wall-clock time (which task is "current" right now) that revalidation
// alone wouldn't catch.
export const dynamic = "force-dynamic";

/**
 * A database failure here (or anywhere requireUser()/the repositories throw) is caught by
 * the nearest error boundary — src/app/(app)/error.tsx — automatically; there is
 * deliberately no try/catch in this file. An empty day/task list is handled by
 * TodayTimeline's own empty state, not here.
 *
 * On a user's first visit the server doesn't know their timezone yet and creates no day; it
 * returns `needs-timezone`, and TimezoneSetup reports the browser's zone and refreshes.
 */
export default async function TodayPage() {
  const snapshot = await getTodaySnapshot();
  if (snapshot.kind === "needs-timezone") return <TimezoneSetup />;

  return (
    <DashboardView
      initialTasks={snapshot.tasks}
      initialBriefingText={snapshot.briefingText ?? ""}
      initialNow={snapshot.now}
    />
  );
}
