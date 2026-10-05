"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/ui/toast-provider";
import { getVapidPublicKey } from "@/config/env.public";
import {
  getExistingSubscription,
  isPushSupported,
  normalizeSubscription,
  registerServiceWorker,
  subscribeToPush,
} from "@/lib/push/push-client";
import {
  canStartDisable,
  canStartEnable,
  runDisableFlow,
  runEnableFlow,
  stateAfterDisable,
  stateAfterMountCheck,
  type PushNotificationsState,
} from "./push-notification-flow";
import { registerPushSubscriptionAction, revokePushSubscriptionAction } from "./actions";

export type { PushNotificationsState };

export interface UsePushNotificationsResult {
  state: PushNotificationsState;
  enable: () => void;
  disable: () => void;
}

/**
 * Drives the "Enable notifications" control end to end for THIS browser/device. This hook is a
 * thin React wrapper — every actual decision (what state a mount observation implies, whether a
 * click is allowed to start something, what an enable/disable attempt's outcome means) lives in
 * `push-notification-flow.ts`, a plain, dependency-injected module with no React and no browser
 * API of its own, unit-tested directly. This mirrors how `use-ai-plan-flow.ts` relates to
 * `flow-state.ts`: this hook itself is verified by inspection/e2e, not a unit test, consistent
 * with this project having no React Testing Library dependency.
 *
 *   mount: detect support → ensure a worker is registered → read (never request) permission
 *          → read this device's existing subscription, if any → derive the starting state
 *   click "Enable": request permission (ONLY now) → ensure worker → obtain/reuse subscription
 *          → register it with the server (Server Action) → enabled only once that succeeds
 *   click "Turn off": revoke server-side → unsubscribe in the browser
 *
 * This device's own subscription state is read straight from the browser (`getSubscription()`),
 * never from a server round trip — the browser is already the source of truth for "does THIS
 * device hold an active subscription" (Phase 6.1). The server remains the sole authority for
 * whether a subscription is actually *registered*: `enabled` is never set until
 * `registerPushSubscriptionAction` itself has returned success.
 */
export function usePushNotifications(): UsePushNotificationsResult {
  const { toast } = useToast();
  const [state, setState] = useState<PushNotificationsState>("checking");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supported = isPushSupported();
      if (!supported) {
        if (!cancelled) setState("unsupported");
        return;
      }
      // Registering here is not itself part of the explicit enable flow's own guarantee (that
      // one re-ensures registration too, see `subscribeToPush`) — it just means the worker is
      // already available by the time `getExistingSubscription()` below needs it, and by the
      // time the button below is even interactive (this effect hasn't set a clickable state yet).
      await registerServiceWorker();

      const vapidPublicKey = getVapidPublicKey();
      const permission: NotificationPermission =
        typeof Notification !== "undefined" ? Notification.permission : "denied";
      const subscription = await getExistingSubscription().catch(() => null);

      if (!cancelled) {
        setState(
          stateAfterMountCheck({
            supported,
            vapidConfigured: Boolean(vapidPublicKey),
            permission,
            hasExistingSubscription: subscription !== null,
          }),
        );
      }
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
    if (!canStartEnable(state)) return; // duplicate click, or a state this control can't start from.
    const vapidPublicKey = getVapidPublicKey();
    if (!vapidPublicKey) {
      setState("not_configured");
      return;
    }
    void (async () => {
      const outcome = await runEnableFlow(
        vapidPublicKey,
        { subscribeToPush, normalizeSubscription, registerPushSubscriptionAction },
        (phase) => setState(phase),
      );
      if (outcome.kind === "enabled") {
        setState("enabled");
        return;
      }
      showError(outcome.message);
      // A denied permission gets its own explanatory state (no retry control shown); every
      // other recoverable failure lands on `error`, which — unlike `permission_denied` — the
      // user can retry from.
      setState(outcome.kind === "permission_denied" ? "permission_denied" : "error");
    })();
  }, [state, showError]);

  const disable = useCallback(() => {
    if (!canStartDisable(state)) return;
    setState("revoking");
    void (async () => {
      const outcome = await runDisableFlow({
        getExistingSubscription,
        revokePushSubscriptionAction,
      });
      if (outcome.kind === "disabled") {
        // Revoking a subscription does not revoke the browser permission — read (never request)
        // what it is now to pick the right resting state.
        setState(
          stateAfterDisable(
            typeof Notification !== "undefined" ? Notification.permission : "default",
          ),
        );
        return;
      }
      showError(outcome.message);
      // The subscription is still active server-side (the revoke itself failed) — showing
      // anything but `enabled` here would falsely claim notifications are off.
      setState("enabled");
    })();
  }, [state, showError]);

  return { state, enable, disable };
}
