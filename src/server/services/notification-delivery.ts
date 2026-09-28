import "server-only";
import { getWebPushConfig, type WebPushConfig } from "@/config/env.server";
import { InternalError } from "@/server/errors";
import { logger } from "@/server/logging/logger";
import { sendWebPush } from "@/server/notifications/web-push-provider";
import { buildTaskReminderPayload } from "@/lib/notifications/task-reminder-payload";
import {
  listActiveSubscriptionsForUser,
  revokePushSubscriptionById,
} from "@/server/db/repositories/push-subscriptions";
import { getTaskTitleForDelivery } from "@/server/db/repositories/tasks";
import {
  markNotificationSent,
  type ScheduledNotification,
} from "@/server/db/repositories/scheduled-notifications";
import type { SupabaseServiceRoleClient } from "@/server/db/supabase-service-role";

/**
 * Web Push delivery for notifications Phase 6.2 has already atomically claimed. This is where
 * "provider accepted the request" and "the user actually saw it" are kept explicitly distinct:
 * everything here can observe is 1) the notification was claimed, 2) a delivery attempt was
 * made, 3) the provider's HTTP response to that attempt. Whether the browser or OS ultimately
 * displayed the notification (Phase 6.4's territory, not built yet) is NOT something this
 * service can know, and it never claims otherwise — see `NotificationDeliveryOutcome` below.
 *
 * AGGREGATE POLICY (the one this module implements, chosen deliberately — see
 * PROJECT_ARCHITECTURE.md's Phase 6.3 section for the full reasoning):
 *
 *   - Zero active subscriptions            → leave the row `claimed`, do nothing further.
 *   - At least one successful acceptance   → mark the row `sent` (regardless of how many of
 *                                             the OTHER subscriptions failed — one success is
 *                                             success; not every device needs to succeed).
 *   - No successes, at least one attempt    → leave the row `claimed`, do nothing further,
 *     (all transient, all permanently         REGARDLESS of whether the failures were transient
 *      invalid, or a mix of the two)          or permanent. Permanently invalid subscriptions
 *                                             are still individually revoked either way.
 *
 * "Leave the row `claimed`" is not a no-op by accident: Phase 6.2's OWN, already-hardened
 * lease-recovery step (in `reconcile_and_claim_notifications`) is what decides what happens
 * next — reclaim it (attempts remain) or give up (`expired`, attempts exhausted) — on a LATER
 * cron tick. Phase 6.3 introduces no second attempt counter and no second retry mechanism; it
 * only ever adds the one new terminal transition Phase 6.2 never performs itself: `sent`.
 *
 * CRASH / AT-LEAST-ONCE: a notification is claimed (Phase 6.2, committed) before it is ever
 * sent (this module). If the process crashes between a successful provider acceptance and
 * `markNotificationSent` running, the row stays `claimed`, its lease eventually expires, and it
 * becomes claimable again — the SAME notification can then be delivered a second time. This is
 * an accepted, documented at-least-once characteristic, not a bug: Phase 6.3 does not attempt,
 * and does not claim, exactly-once delivery at any layer.
 */

export interface NotificationDeliveryOutcome {
  notificationId: string;
  /** True iff at least one subscription's provider acceptance succeeded — NOT proof the user
   *  saw anything, only that the row was marked `sent`. */
  delivered: boolean;
  attemptedSubscriptions: number;
  successes: number;
  permanentlyInvalid: number;
  transientFailures: number;
}

/**
 * Delivers every claimed notification to every active subscription of its own user. Never
 * called from a user-facing path — only `runNotificationScheduler` (the CRON_SECRET-gated
 * system path) calls this, with the service-role client it already holds.
 */
export async function deliverClaimedNotifications(
  supabase: SupabaseServiceRoleClient,
  claimed: readonly ScheduledNotification[],
): Promise<NotificationDeliveryOutcome[]> {
  if (claimed.length === 0) return [];

  const config = getWebPushConfig();
  if (!config) throw new InternalError({ message: "Web Push delivery is not configured." });

  const outcomes: NotificationDeliveryOutcome[] = [];
  for (const notification of claimed) {
    outcomes.push(await deliverOne(supabase, config, notification));
  }
  return outcomes;
}

async function deliverOne(
  supabase: SupabaseServiceRoleClient,
  config: WebPushConfig,
  notification: ScheduledNotification,
): Promise<NotificationDeliveryOutcome> {
  const empty: NotificationDeliveryOutcome = {
    notificationId: notification.id,
    delivered: false,
    attemptedSubscriptions: 0,
    successes: 0,
    permanentlyInvalid: 0,
    transientFailures: 0,
  };

  // The notification's OWN user_id (the authoritative claimed row) is what scopes the
  // subscription read — never anything a payload or a client could supply.
  const [taskTitle, subscriptions] = await Promise.all([
    getTaskTitleForDelivery(supabase, notification.taskId),
    listActiveSubscriptionsForUser(supabase, notification.userId),
  ]);

  if (!taskTitle || subscriptions.length === 0) {
    // Case A (no active subscriptions) — and the defensive case of a since-deleted task.
    // Nothing to attempt; leave the row `claimed` for Phase 6.2's own lease recovery.
    logger.info("notification delivery: nothing to deliver to", {
      notificationId: notification.id,
      taskId: notification.taskId,
      reason: taskTitle ? "no_active_subscriptions" : "task_not_found",
    });
    return empty;
  }

  const payload = buildTaskReminderPayload({
    notificationId: notification.id,
    taskId: notification.taskId,
    taskTitle,
    scheduledStart: notification.taskScheduledStartSnapshot,
  });

  let successes = 0;
  let permanentlyInvalid = 0;
  let transientFailures = 0;

  for (const subscription of subscriptions) {
    const result = await sendWebPush(config, subscription, payload);
    logger.info("notification delivery: attempt", {
      notificationId: notification.id,
      subscriptionId: subscription.id,
      outcome: result.outcome,
      statusCode: result.statusCode,
    });

    if (result.outcome === "success") {
      successes += 1;
    } else if (result.outcome === "permanently_invalid") {
      permanentlyInvalid += 1;
      // One dead subscription must never stop the loop — fan-out continues regardless.
      await revokePushSubscriptionById(supabase, subscription.id);
    } else {
      transientFailures += 1;
    }
  }

  if (successes > 0) {
    await markNotificationSent(supabase, notification.id);
  }
  // No successes: the row stays `claimed` — see the module doc comment for why that is enough.

  return {
    notificationId: notification.id,
    delivered: successes > 0,
    attemptedSubscriptions: subscriptions.length,
    successes,
    permanentlyInvalid,
    transientFailures,
  };
}
