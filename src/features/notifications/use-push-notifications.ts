"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/ui/toast-provider";
import { getVapidPublicKey } from "@/config/env.public";
import {
  getExistingSubscription,
  isPushClientError,
  isPushSupported,
  normalizeSubscription,
  pushClientError,
  registerServiceWorker,
  subscribeToPush,
} from "@/lib/push/push-client";
import { registerPushSubscriptionAction, revokePushSubscriptionAction } from "./actions";

export type PushNotificationsState =
  /** Still inspecting the browser on mount — render nothing rather than flash a wrong state. */
  | "checking"
  /** No ServiceWorker/PushManager/Notification API, or not a secure context. Hidden, not an
   *  error: most users on an unsupported browser should never see this feature at all. */
  | "unsupported"
  /** Supported, but the server hasn't configured a VAPID key yet (a later Phase 6 step). Same
   *  user-facing treatment as "unsupported" — the feature genuinely isn't available yet. */
  | "not_configured"
  /** The user (or their browser policy) has explicitly refused permission. Browsers will not
   *  re-prompt, so there is nothing to offer here except an explanation. */
  | "denied"
  /** Permission is grantable (or already granted) but this device has no active subscription. */
  | "off"
  | "subscribing"
  /** This device has an active subscription registered with the server. */
  | "on"
  | "revoking";

export interface UsePushNotificationsResult {
  state: PushNotificationsState;
  enable: () => void;
  disable: () => void;
}

/**
 * Drives the "Enable notifications" control end to end for THIS browser/device:
 *
 *   detect support → request permission (only on explicit click, never on mount)
 *   → obtain a PushManager subscription → register it with the server (Server Action)
 *   → later: revoke it, both server-side and at the browser level
 *
 * `subscribeToPush` and `getExistingSubscription` (src/lib/push/push-client.ts) use
 * `getRegistration()` rather than `.ready` and treat "no worker registered" as a normal,
 * non-crashing outcome (`service_worker_unavailable`). Phase 6.4 registers `public/sw.js` (see
 * `registerServiceWorker()` below) so `getRegistration()` has something to find — registering
 * does not itself request permission or create a subscription, both of which still only ever
 * happen from `enable()`'s own click handler.
 *
 * This device's own subscription state is read straight from the browser (`getSubscription()`),
 * never from a server round trip: the browser is already the source of truth for "does THIS
 * device hold an active subscription", so no read endpoint is needed for that in Phase 6.1.
 */
export function usePushNotifications(): UsePushNotificationsResult {
  const { toast } = useToast();
  const [state, setState] = useState<PushNotificationsState>("checking");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!isPushSupported()) {
        if (!cancelled) setState("unsupported");
        return;
      }
      await registerServiceWorker();
      if (!getVapidPublicKey()) {
        if (!cancelled) setState("not_configured");
        return;
      }
      if (typeof Notification !== "undefined" && Notification.permission === "denied") {
        if (!cancelled) setState("denied");
        return;
      }
      const subscription = await getExistingSubscription().catch(() => null);
      if (!cancelled) setState(subscription ? "on" : "off");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const showError = useCallback(
    (message: string) => toast({ title: "Notifications", description: message, tone: "error" }),
    [toast],
  );

  const enable = useCallback(() => {
    const vapidPublicKey = getVapidPublicKey();
    if (!vapidPublicKey) {
      setState("not_configured");
      return;
    }
    setState("subscribing");
    void (async () => {
      try {
        const subscription = await subscribeToPush(vapidPublicKey);
        const normalized = normalizeSubscription(subscription);
        const result = await registerPushSubscriptionAction(normalized);
        if (!result.ok) {
          showError(result.error.message);
          setState("off");
          return;
        }
        setState("on");
      } catch (error) {
        if (isPushClientError(error)) {
          showError(error.message);
          setState(error.reason === "permission_denied" ? "denied" : "off");
          return;
        }
        showError(pushClientError("subscribe_failed").message);
        setState("off");
      }
    })();
  }, [showError]);

  const disable = useCallback(() => {
    setState("revoking");
    void (async () => {
      try {
        const subscription = await getExistingSubscription();
        if (subscription) {
          const result = await revokePushSubscriptionAction({ endpoint: subscription.endpoint });
          if (!result.ok) {
            showError(result.error.message);
            setState("on");
            return;
          }
          await subscription.unsubscribe();
        }
        setState("off");
      } catch {
        showError(pushClientError("revoke_failed").message);
        setState("on");
      }
    })();
  }, [showError]);

  return { state, enable, disable };
}
