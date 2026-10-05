import type { ActionResult } from "@/server/errors";
import {
  isPushClientError,
  pushClientError,
  type NormalizedPushSubscription,
} from "@/lib/push/push-client";

/**
 * Pure decision logic + injectable async orchestration for the notification control — no React,
 * no direct browser API call, no direct network call. Mirrors the same split
 * `ai-planning/flow-state.ts` uses: the hook that drives the real UI (`use-push-notifications.ts`)
 * only calls these functions with values/dependencies it already has; every decision (what state
 * results from what mount observation, whether a click is allowed to start something, what a
 * flow's outcome should be) is made here and is fully unit-testable without a DOM or React
 * Testing Library, consistent with this project's established "no RTL" convention.
 *
 * Unlike the AI-planning flow, notification enable/disable is a single linear operation with no
 * legitimate concurrent/stale-result race to guard against — there is no "a slower request lands
 * after a faster one" hazard here, only "the user clicked twice", which a plain state guard
 * (`canStartEnable`/`canStartDisable`) fully closes without needing an epoch.
 */

export type PushNotificationsState =
  /** Still running the mount-time checks — render nothing rather than flash a wrong state. */
  | "checking"
  /** No ServiceWorker/PushManager/Notification API, or not a secure context. Hidden, not an
   *  error: most users on an unsupported browser should never see this feature at all. */
  | "unsupported"
  /** Supported, but the server hasn't configured a VAPID key yet. Same user-facing treatment as
   *  "unsupported" — the feature genuinely isn't available yet. */
  | "not_configured"
  /** The user (or their browser policy) has explicitly refused permission. Browsers will not
   *  re-prompt for a denied permission, so there is nothing to offer here except an explanation
   *  — and no "Enable" control is rendered at all for this state, so there is no way for the UI
   *  itself to trigger a repeated request. */
  | "permission_denied"
  /** Browser permission has not been decided yet ("default") and this device has no active
   *  subscription. Enabling will show the browser's permission prompt (only on click). */
  | "permission_default"
  /** Browser permission is already granted, but this device has no active subscription — so
   *  `Notification.permission === "granted"` is deliberately NOT treated as "enabled". Enabling
   *  skips the prompt (the browser resolves an already-decided permission immediately) and goes
   *  straight to obtaining a subscription. */
  | "permission_granted"
  /** `subscribeToPush()` in flight: requests permission (only now, never earlier), ensures a
   *  service worker is available, and obtains/reuses a PushManager subscription. */
  | "subscribing"
  /** The obtained subscription is being registered with the existing Phase 6.1 server-side
   *  flow (Server Action → service → repository → RPC). Not yet "enabled" — the UI must not
   *  claim success before this step's own result comes back. */
  | "registering"
  /** A subscription exists on this device AND the server has confirmed it is registered. */
  | "enabled"
  | "revoking"
  /** A recoverable enable/subscribe/register failure. The user can retry from here (unlike
   *  `permission_denied`, which is not retryable through this UI at all). */
  | "error";

export interface MountObservation {
  supported: boolean;
  vapidConfigured: boolean;
  /** The browser's OWN, already-decided permission — read, never requested. Taking this as a
   *  plain input value (rather than calling `Notification.requestPermission()` itself) is what
   *  makes "mount alone never requests permission" a structural property of this function: there
   *  is no `Notification` reference anywhere in this file for it to call even if it wanted to. */
  permission: NotificationPermission;
  hasExistingSubscription: boolean;
}

/** The state the control settles into after the hook's mount-time checks. */
export function stateAfterMountCheck(observation: MountObservation): PushNotificationsState {
  if (!observation.supported) return "unsupported";
  if (!observation.vapidConfigured) return "not_configured";
  if (observation.permission === "denied") return "permission_denied";
  if (observation.hasExistingSubscription) return "enabled";
  return observation.permission === "granted" ? "permission_granted" : "permission_default";
}

/** Where the control lands after a successful disable. The browser-level permission outlives the
 *  subscription (revoking a subscription does not revoke the permission), so this is derived
 *  from the permission the caller observed, never assumed. */
export function stateAfterDisable(permission: NotificationPermission): PushNotificationsState {
  if (permission === "denied") return "permission_denied";
  return permission === "granted" ? "permission_granted" : "permission_default";
}

/** True only from a state where starting a fresh enable flow makes sense. A duplicate click
 *  while a flow is already in progress (`subscribing`/`registering`), or one that lands on an
 *  already-`enabled` device, is simply ignored — this is the entire "no duplicate subscriptions
 *  from repeated clicks" guarantee (section 11), and it needs no additional locking because
 *  `enable()` only ever calls this with the hook's own current state. */
export function canStartEnable(state: PushNotificationsState): boolean {
  return state === "permission_default" || state === "permission_granted" || state === "error";
}

/** Mirrors `canStartEnable` for the disable/revoke direction. */
export function canStartDisable(state: PushNotificationsState): boolean {
  return state === "enabled";
}

export interface EnableFlowDeps {
  subscribeToPush: (vapidPublicKey: string) => Promise<PushSubscription>;
  normalizeSubscription: (subscription: PushSubscription) => NormalizedPushSubscription;
  registerPushSubscriptionAction: (
    input: NormalizedPushSubscription,
  ) => Promise<ActionResult<void>>;
}

export type EnableFlowOutcome =
  | { kind: "enabled" }
  | { kind: "permission_denied"; message: string }
  | { kind: "error"; message: string };

/**
 * The entire explicit-enable flow (spec section 4, steps 3–9), as one dependency-injected async
 * function: no browser global and no Server Action import lives in this file, so a test can
 * exercise every branch — permission denied, service-worker/subscribe failure, an existing
 * subscription being reused (that's `deps.subscribeToPush`'s own job, unchanged — see
 * `push-client.ts`), server registration failure, and full success — with plain `vi.fn()` mocks
 * and no DOM. `onPhase` is called synchronously at the start of each step so the caller (the
 * hook) can reflect `subscribing`/`registering` in the UI without this function knowing React
 * exists.
 *
 * The UI is never told `enabled` before `registerPushSubscriptionAction` itself has succeeded —
 * there is no path through this function that returns `{ kind: "enabled" }` any other way.
 */
export async function runEnableFlow(
  vapidPublicKey: string,
  deps: EnableFlowDeps,
  onPhase: (phase: "subscribing" | "registering") => void,
): Promise<EnableFlowOutcome> {
  onPhase("subscribing");
  let subscription: PushSubscription;
  try {
    subscription = await deps.subscribeToPush(vapidPublicKey);
  } catch (error) {
    if (isPushClientError(error)) {
      if (error.reason === "permission_denied") {
        return { kind: "permission_denied", message: error.message };
      }
      return { kind: "error", message: error.message };
    }
    // An unexpected (non-PushClientError) throw — from `normalizeSubscription`-shaped input
    // issues or any other browser surprise — is still reported as a user-safe, fixed message,
    // never the raw caught value (which could in principle carry request/browser detail this
    // app never wants surfaced).
    return { kind: "error", message: pushClientError("subscribe_failed").message };
  }

  let normalized: NormalizedPushSubscription;
  try {
    normalized = deps.normalizeSubscription(subscription);
  } catch {
    return { kind: "error", message: pushClientError("subscribe_failed").message };
  }

  onPhase("registering");
  const result = await deps.registerPushSubscriptionAction(normalized);
  if (!result.ok) return { kind: "error", message: result.error.message };
  return { kind: "enabled" };
}

export interface DisableFlowDeps {
  getExistingSubscription: () => Promise<PushSubscription | null>;
  revokePushSubscriptionAction: (input: { endpoint: string }) => Promise<ActionResult<void>>;
}

export type DisableFlowOutcome = { kind: "disabled" } | { kind: "error"; message: string };

/**
 * Mirrors `runEnableFlow` for the (already-existing, Phase 6.1) disable/revoke direction — no
 * new disable UI or second subscription-management workflow is introduced here, only this same
 * dependency-injection split applied to the flow that was already there.
 */
export async function runDisableFlow(deps: DisableFlowDeps): Promise<DisableFlowOutcome> {
  try {
    const subscription = await deps.getExistingSubscription();
    if (subscription) {
      const result = await deps.revokePushSubscriptionAction({ endpoint: subscription.endpoint });
      if (!result.ok) return { kind: "error", message: result.error.message };
      await subscription.unsubscribe();
    }
    return { kind: "disabled" };
  } catch {
    return { kind: "error", message: pushClientError("revoke_failed").message };
  }
}
