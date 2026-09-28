import "server-only";
import { logger } from "@/server/logging/logger";
import { InternalError } from "@/server/errors";
import { createSupabaseServiceRoleClient } from "@/server/db/supabase-service-role";
import { reconcileAndClaimNotifications } from "@/server/db/repositories/scheduled-notifications";
import { deliverClaimedNotifications } from "./notification-delivery";

export interface RunNotificationSchedulerResult {
  claimedCount: number;
  /** How many of the claimed notifications had at least one successful provider acceptance —
   *  NOT how many the user actually saw (see notification-delivery.ts's own doc comment). */
  deliveredCount: number;
}

/**
 * The entire Phase 6.2 + 6.3 pipeline in one call: reconcile `scheduled_notifications` against
 * live tasks, atomically claim whatever is due, then attempt Web Push delivery for exactly
 * those claimed rows. Called ONLY from the CRON_SECRET-gated system route
 * (`src/app/api/cron/notifications/route.ts`) — never from a user-facing path, and never given
 * a user session, which is why this takes no arguments and does no `requireUser*()` check: the
 * route's own `isAuthorizedCronRequest()` is the entire authorization boundary here.
 *
 * Reconciliation/claiming and delivery are deliberately two separate steps, not one combined
 * database transaction: claiming is a fast, purely-database operation Phase 6.2 already made
 * atomic; delivery makes real network calls to a third-party provider, which must never hold a
 * database transaction open. This is exactly the documented claim/delivery race — see
 * notification-delivery.ts — an accepted at-least-once characteristic, not an oversight.
 *
 * Logs only operational counts, never task titles, user ids, or push credentials.
 */
export async function runNotificationScheduler(): Promise<RunNotificationSchedulerResult> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    throw new InternalError({ message: "Notification scheduling is not configured." });
  }

  const claimed = await reconcileAndClaimNotifications(supabase);
  logger.info("notification scheduler: reconciled and claimed", { claimedCount: claimed.length });

  const results = await deliverClaimedNotifications(supabase, claimed);
  const deliveredCount = results.filter((r) => r.delivered).length;
  logger.info("notification scheduler: delivery complete", {
    claimedCount: claimed.length,
    deliveredCount,
  });

  return { claimedCount: claimed.length, deliveredCount };
}
