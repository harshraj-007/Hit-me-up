import { NextResponse } from "next/server";
import { withErrorHandling } from "@/server/errors";
import { isAuthorizedCronRequest } from "@/server/auth/cron";
import { runNotificationScheduler } from "@/server/services/notification-scheduler";

export const dynamic = "force-dynamic";

/**
 * The Vercel Cron entry point for Phase 6.2 (configured to run every minute — see
 * PROJECT_ARCHITECTURE.md). Gated by `CRON_SECRET`, never a user session: there is no
 * `requireUser()` here because there is no user to require — `isAuthorizedCronRequest` is the
 * entire authorization boundary. Whether the secret is merely unset or simply wrong, the
 * response is identically 401 either way (see that function's own comment).
 *
 * Safe to invoke repeatedly and concurrently: `runNotificationScheduler` does nothing but call
 * one atomic, `FOR UPDATE SKIP LOCKED`-based database transaction — there is no in-memory or
 * process-local state here to make unsafe. Delivery (Phase 6.3) is not implemented: this route
 * only reconciles and claims.
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
    { claimed: result.claimedCount },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
});
