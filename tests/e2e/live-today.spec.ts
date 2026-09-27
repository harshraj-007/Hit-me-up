import { test } from "@playwright/test";

/**
 * Persisted-flow specs for Today, cross-midnight tasks and future-day planning. Like
 * `persisted-today.spec.ts` they are written out but skipped: every one needs an authenticated
 * session, and the only sign-in path is a real Supabase magic-link email — there is
 * deliberately no password login or auth bypass in production code (PROJECT_ARCHITECTURE.md).
 * Enable them by wiring one of the options in persisted-today.spec.ts (a local Supabase stack +
 * its mail inbox, or a seeded session against a test project), then remove the `.skip`s.
 *
 * What each must assert once enabled:
 */

test.describe("live Today (needs an authenticated session)", () => {
  test.skip("today loads with the day's clock, progress and Now marker", async () => {
    // open /today -> header shows the day's date, a clock in the DAY's timezone, the Now marker
    // sits in the timeline, and the day navigator's "Previous day" control is disabled.
  });

  test.skip("complete: complete a task, reload, it is still Completed", async () => {
    // open /today -> add a task -> click "Complete" -> toast "Marked complete" ->
    // page.reload() -> the same task shows "Completed" and the header count went up.
  });

  test.skip("skip: skip a task, reload, it is still Skipped and not counted in progress", async () => {
    // open /today -> add two tasks -> "Skip" one -> reload -> it shows "Skipped";
    // the header denominator excludes it (completed / (total - skipped)).
  });

  test.skip("navigate to tomorrow and create a future-day task", async () => {
    // click "Next day" -> URL is /today?date=<tomorrow>, header reads "Planning for <date>",
    // no Now marker -> "Add task" (planning day defaults to the day on screen) -> 18:00, 90 min ->
    // the task appears in THIS timeline. Return to today (the "Today" link): it is NOT in today's timeline.
  });

  test.skip("date navigation is limited to today .. today+365 and bad dates redirect to today", async () => {
    // "Previous day" is disabled on today; the picker has min=today, max=today+365;
    // page.goto('/today?date=<yesterday>'), '?date=<today+366>', '?date=nonsense' each end at /today.
  });

  test.skip("cross-midnight create: 23:30 + 90 min is Ends next day, shows +1 day, stays on its day", async () => {
    // "Add task" for today at 23:30 for 90 minutes -> the dialog preview says "Ends next day",
    // the row reads "11:30 PM – 1:00 AM +1 day" -> reload: still in TODAY's timeline.
  });

  test.skip("reschedule across midnight keeps the task on its original planning day and its duration", async () => {
    // "Reschedule" a 90-minute task -> the dialog shows only "New start" and the fixed length ->
    // enter 23:30 -> the preview reads "11:30 PM – 1:00 AM +1 day / Ends next day" -> Save -> row shows
    // "+1 day", "Moved by you" and still 1h 30m -> reload -> same, still on this day. There is no end field.
  });

  test.skip("spillover: yesterday's running task shows under 'From <date>' and is not in progress", async () => {
    // with a task that started yesterday 23:30 and ends today 01:00 (opened between 00:00 and 01:00):
    // it appears in the 'From ...' group at the top of Today, can be completed/skipped/rescheduled,
    // and the header's "X of Y done" total does NOT include it.
  });

  test.skip("replan (today): reports overlaps and changes nothing on a user-only day", async () => {
    // add two overlapping tasks -> click "Replan remaining day" -> toast "Nothing to change" mentioning the
    // overlap; both rows show "Overlaps another task"; reload -> unchanged, no new plan revision.
  });

  test.skip("replan (future day): 'Replan this day' works over the whole day; a day with no tasks is a no-op", async () => {
    // on a future day with no row the button is disabled; after adding a task it is enabled and reports
    // 'Nothing to change' (no planner tasks exist to move until the AI phase).
  });

  test.skip("derived late: an overdue task shows Late and can still be completed or rescheduled", async () => {
    // wait for a task's window to elapse (or use a clock override) -> row shows "Late" -> "Reschedule" is offered.
  });
});
