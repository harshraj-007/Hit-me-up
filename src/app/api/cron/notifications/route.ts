import { NextResponse } from "next/server";
import { withErrorHandling } from "@/server/errors";
import { isAuthorizedCronRequest } from "@/server/auth/cron";
import { runNotificationScheduler } from "@/server/services/notification-scheduler";

export const dynamic = "force-dynamic";

/**
 * The Vercel Cron entry point for notification reconciliation, claiming, AND delivery
 * (configured to run every minute — see PROJECT_ARCHITECTURE.md). One endpoint for the whole
 * pipeline, not a second one for delivery: Phase 6.3 extended `runNotificationScheduler`
 * in place rather than adding a route here. Gated by `CRON_SECRET`, never a user session:
 * there is no `requireUser()` here because there is no user to require —
 * `isAuthorizedCronRequest` is the entire authorization boundary. Whether the secret is merely
 * unset or simply wrong, the response is identically 401 either way (see that function's own
 * comment).
 *
 * Safe to invoke repeatedly and concurrently: claiming is one atomic, `FOR UPDATE SKIP
 * LOCKED`-based database transaction, and delivery's own idempotency comes from Phase 6.2's
 * claim state, not from anything in this route or process — there is no in-memory or
 * process-local state here to make unsafe. `delivered` counts notifications with at least one
 * successful Web Push provider acceptance — it is not, and must never be read as, proof the
 * user saw anything (see `notification-delivery.ts`).
 */
export const POST = withErrorHandling(async (request) => {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "Unauthorized." } },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await runNotificationScheduler();
  return NextResponse.json(
    { claimed: result.claimedCount, delivered: result.deliveredCount },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
});
