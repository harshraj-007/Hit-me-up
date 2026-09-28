import "server-only";
import webpush from "web-push";
import type { WebPushConfig } from "@/config/env.server";

/**
 * The ONLY module in this codebase that imports `web-push` — the narrow boundary the delivery
 * service (`src/server/services/notification-delivery.ts`) calls through, and the narrow
 * boundary tests mock, per Phase 6.3's own instruction not to hand-roll VAPID signing or Web
 * Push encryption: this wraps the established library's real behavior, it does not replace it.
 *
 * `web-push`'s own classification is coarse (throws `WebPushError` with a `statusCode` on any
 * non-2xx, resolves on 2xx) — everything this module adds is turning that into the three
 * outcomes the delivery service actually needs to act on differently. It has no notion of
 * retrying, revoking, or finalizing anything; those are the delivery service's job, one layer
 * up, working from the classification this module returns.
 */

export interface WebPushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  authKey: string;
}

export type WebPushOutcome = "success" | "permanently_invalid" | "transient_failure";

export interface WebPushSendResult {
  outcome: WebPushOutcome;
  /** The provider's HTTP status, when one was actually returned (absent for a network-level
   *  failure — a timeout or connection error never reaches an HTTP response at all). */
  statusCode?: number;
}

/** A push message is only ever useful for a short window after "10 minutes before" has
 *  already been computed — keeping the push service from holding and delivering a stale
 *  reminder hours or days later if a device is offline. */
const TTL_SECONDS = 15 * 60;
/** Bounds a single delivery attempt so one slow/hung device can't stall an entire cron cycle
 *  (which is fanning out to potentially many subscriptions across potentially many claimed
 *  notifications, all within a route that itself runs once a minute). */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Sends one Web Push message to one subscription and classifies the outcome. Never throws for
 * an ordinary delivery failure (transient or permanent) — only for a genuinely unexpected,
 * non-Web-Push-shaped error, which the caller should treat as a bug, not a delivery outcome.
 *
 * Classification is deliberately conservative, per the Phase 6.3 spec: ONLY 404/410 are
 * `permanently_invalid` (the push service itself saying the subscription is gone for good);
 * every other non-success — 429, any 5xx, any other 4xx, and any network-level failure
 * (timeout, connection error, DNS failure, ...) — is `transient_failure`. An unrecognized
 * status code is never silently treated as permanent.
 */
export async function sendWebPush(
  config: WebPushConfig,
  subscription: WebPushSubscriptionInput,
  payload: unknown,
): Promise<WebPushSendResult> {
  try {
    const result = await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.authKey },
      },
      JSON.stringify(payload),
      {
        vapidDetails: {
          subject: config.subject,
          publicKey: config.publicKey,
          privateKey: config.privateKey,
        },
        TTL: TTL_SECONDS,
        timeout: REQUEST_TIMEOUT_MS,
      },
    );
    return { outcome: "success", statusCode: result.statusCode };
  } catch (error) {
    if (error instanceof webpush.WebPushError) {
      const permanent = error.statusCode === 404 || error.statusCode === 410;
      return {
        outcome: permanent ? "permanently_invalid" : "transient_failure",
        statusCode: error.statusCode,
      };
    }
    // A network-level failure (timeout, connection reset, DNS failure, ...) never reaches an
    // HTTP response at all — no statusCode to report, and never treated as permanent.
    return { outcome: "transient_failure" };
  }
}
