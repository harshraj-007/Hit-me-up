import { test } from "@playwright/test";

/**
 * Phase 7's end-of-day review, end to end. Like `persisted-today.spec.ts`, `live-today.spec.ts` and
 * `notifications.spec.ts`, every one of these needs an authenticated session (this app's only
 * sign-in path is a real Supabase magic-link email; there is deliberately no password or
 * dev-bypass login) AND a real `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` — neither exists in this
 * sandbox, so they couldn't be built *and verified* honestly here. Everything underneath them is
 * covered without a browser: the deterministic facts, the interpretation validator, the provider
 * adapter (including a stubbed-fetch run of the real SDK), the service, the RPC against a real
 * Postgres, and the panel's display mapping.
 *
 * What each must assert once enabled:
 */
test.describe("end-of-day review (needs an authenticated session + an AI key)", () => {
  test.skip("a day with no tasks: 'Review the day' says there is nothing to review and stores nothing", async () => {
    // open /today with no tasks -> click "Review the day" -> a neutral "Nothing to review yet"
    // toast; no report appears; reload -> still no report.
  });

  test.skip("a partly done day: the review shows the takeaway, the done/skipped/open counts, and EVERY unresolved task under Carry forward", async () => {
    // complete one task, skip one, leave one past its time -> click "Review the day" -> counts read
    // 1 done · 1 skipped · 1 still open; the slipped task appears under Carry forward with its
    // "Past its time" label; task titles shown are the user's own.
  });

  test.skip("the review persists: a reload shows the same review, with no new model call", async () => {
    // generate -> reload -> same takeaway text and 'Reviewed at' time (no 'Reviewing…').
  });

  test.skip("a changed day marks the review stale and offers an update — it never rewrites itself", async () => {
    // generate -> complete another task -> reload -> 'Your day has changed since this review.' and
    // an 'Update review' button; the old text is still shown until the button is clicked.
  });

  test.skip("double-clicking 'Review the day' makes one request and one report", async () => {
    // click twice quickly -> the button is disabled after the first click; one report row only.
  });

  test.skip("a future day has no review panel at all", async () => {
    // /today?date=<tomorrow> -> no 'Wrap up the day' section.
  });
});
