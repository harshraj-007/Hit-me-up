import { test } from "@playwright/test";

/**
 * Phase 6.5's notification enable/disable flow, end to end. Like `persisted-today.spec.ts` and
 * `live-today.spec.ts`, every one of these needs an authenticated session, and this app's only
 * sign-in path is a real Supabase magic-link email — there is deliberately no password or
 * dev-bypass login (PROJECT_ARCHITECTURE.md). This sandbox has neither the Supabase CLI/Docker
 * nor a real project's credentials, so these couldn't be built *and verified* honestly here; see
 * `persisted-today.spec.ts`'s own comment for the two ways to wire up a real session.
 *
 * Once that exists, the browser-permission side is straightforward to mock with Playwright
 * alone (no auth needed for this part): `context.grantPermissions(["notifications"])` or
 * `context.clearPermissions()` before navigating sets what `Notification.permission` reports,
 * and Chromium's Push API is exercised for real once a session and a configured VAPID key are
 * both present — no additional mocking is needed beyond the permission grant.
 *
 * What each must assert once enabled:
 */
test.describe("notification enable/disable (needs an authenticated session)", () => {
  test.skip("unsupported/not-configured: with no VAPID key configured, the notifications control renders nothing", async () => {
    // open /today with NEXT_PUBLIC_VAPID_PUBLIC_KEY unset -> the sidebar's notifications area
    // is empty; no "Enable notifications" button, no permission text.
  });

  test.skip("default permission: clicking Enable prompts for permission and, once granted, ends on 'Notifications on'", async () => {
    // context.clearPermissions() (permission stays "default") -> open /today -> click "Enable
    // notifications" -> context.grantPermissions(["notifications"]) is set up to auto-accept via
    // Chromium's permission API -> the button briefly shows "Enabling…" (disabled) -> settles on
    // "Notifications on" with a "Turn off" control -> reload -> still "Notifications on" (the
    // server-registered subscription persisted, not a client-only flag).
  });

  test.skip("denied permission: no Enable control is shown, only the blocked explanation — and it never re-prompts", async () => {
    // context.grantPermissions([]) with a denied Notification permission (set via
    // page.addInitScript before the page's own script runs, or the browser's own site setting)
    // -> open /today -> the sidebar shows the "blocked in your browser" text, no button to
    // click -> confirm no permission-prompt dialog is ever triggered by merely loading the page.
  });

  test.skip("turn off: clicking 'Turn off' on an enabled device revokes it server-side and the control returns to 'Enable notifications'", async () => {
    // starting from an already-enabled device (previous test's end state, or a seeded
    // subscription) -> click "Turn off" -> shows "Turning off…" -> settles back on "Enable
    // notifications" -> reload -> still off (not just a client-side flag).
  });

  test.skip("duplicate clicks: rapidly clicking Enable twice registers only one subscription", async () => {
    // open /today with permission already granted, no existing subscription -> click "Enable
    // notifications" twice in quick succession -> only one PushManager subscription is created
    // and only one row is registered server-side (assert via the button becoming disabled
    // immediately on the first click, and only one subscribe network call).
  });
});
