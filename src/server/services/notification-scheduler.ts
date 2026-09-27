import "server-only";
import { logger } from "@/server/logging/logger";
import { InternalError } from "@/server/errors";
import { createSupabaseServiceRoleClient } from "@/server/db/supabase-service-role";
import { reconcileAndClaimNotifications } from "@/server/db/repositories/scheduled-notifications";

export interface RunNotificationSchedulerResult {
  claimedCount: number;
}

/**
 * The entire Phase 6.2 orchestration: reconcile `scheduled_notifications` against live tasks,
 * then atomically claim whatever is due. Called ONLY from the CRON_SECRET-gated system route
 * (`src/app/api/cron/notifications/route.ts`) — never from a user-facing path, and never given
 * a user session, which is why this takes no arguments and does no `requireUser*()` check: the
 * route's own `isAuthorizedCronRequest()` is the entire authorization boundary here, exactly
 * mirroring how `confirmPersistedAiProposal` relies on `requireUserForAction()` for its
 * boundary — this function has the system-path equivalent instead.
 *
 * Deliberately does nothing with the claimed rows beyond counting them: Web Push delivery is
 * Phase 6.3. Logs only operational counts, never task titles, user ids, or push credentials.
 */
export async function runNotificationScheduler(): Promise<RunNotificationSchedulerResult> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    throw new InternalError({ message: "Notification scheduling is not configured." });
  }

  const claimed = await reconcileAndClaimNotifications(supabase);
  logger.info("notification scheduler: reconciled and claimed", { claimedCount: claimed.length });
  return { claimedCount: claimed.length };
}
