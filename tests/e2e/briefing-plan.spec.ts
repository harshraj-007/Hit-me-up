import { test } from "@playwright/test";

/**
 * Phase 8's "Plan my day", end to end. Like `eod.spec.ts`, `notifications.spec.ts` and the other
 * signed-in specs, every one of these needs an authenticated session (this app's only sign-in is a
 * real Supabase magic-link email) AND a real `ANTHROPIC_API_KEY`, so they cannot run in CI. The
 * whole flow below WAS exercised, 61 checks, against a real Next.js build + real Chromium + real
 * Postgres (PostgREST/RLS) with a local Anthropic stand-in — see PROJECT_ARCHITECTURE.md, Phase 8.
 *
 * What each must assert once an authenticated path exists:
 */
test.describe("plan my day from the saved briefing (needs an authenticated session + an AI key)", () => {
  test.skip("the button is disabled until a briefing is SAVED, and again while the box has unsaved edits", async () => {});
  test.skip("generating shows a NEW TASKS group (title, local time range, duration, priority, kind) and creates nothing", async () => {});
  test.skip("Apply creates exactly the proposed tasks (source planner), one ai revision, and the timeline shows them", async () => {});
  test.skip("an invalid proposal (overlap, past, duplicate title, bad fixed task) shows why, disables Apply, creates nothing", async () => {});
  test.skip("a stale proposal (the schedule changed after generating) fails safely on Apply and creates nothing", async () => {});
  test.skip("a provider failure or timeout shows a safe message and persists nothing", async () => {});
  test.skip("the reminder cron then creates one reminder per new task, idempotently", async () => {});
});
