/**
 * Pure, browser-facing Web Push helpers — no React, no Server Action calls. Kept separate from
 * `use-push-notifications.ts` (the hook) the same way `speech-recognition.ts` is kept separate
 * from the AI-planning hook that uses it: the parts that are pure logic are unit-testable here;
 * the hook itself is thin orchestration, verified the same way `use-ai-plan-flow.ts` is (by
 * inspection and end-to-end use), not by rendering it in a unit test — this project has no
 * React Testing Library dependency, by design.
 *
 * Phase 6.1 registers/revokes subscriptions only. It deliberately does NOT create a service
 * worker (that is a later Phase 6 step), so `getExistingSubscription`/`subscribeToPush` below
 * use `navigator.serviceWorker.getRegistration()` rather than `.ready` — `.ready` never
 * resolves until a worker exists, and would hang the "Enable notifications" flow indefinitely
 * on a page that has none yet. `getRegistration()` resolves to `undefined` instead, which this
 * module treats as a normal, honest "not available yet" outcome rather than a crash. Once a
 * later phase registers `public/sw.js`, this same code starts working without a rewrite.
 */

export type PushClientErrorReason =
  | "unsupported"
  | "permission_denied"
  | "service_worker_unavailable"
  | "subscribe_failed"
  | "revoke_failed";

export interface PushClientError {
  reason: PushClientErrorReason;
  /** Fixed, user-safe text — never a raw browser error string (which could, in principle,
   *  embed request detail this app never wants surfaced to the user). */
  message: string;
}

const ERROR_MESSAGES: Record<PushClientErrorReason, string> = {
  unsupported: "Notifications aren't supported in this browser.",
  permission_denied:
    "Notification permission was denied. Allow notifications in your browser settings and try again.",
  service_worker_unavailable: "Notifications aren't fully set up yet. Check back soon.",
  subscribe_failed: "Couldn't enable notifications on this device. Try again.",
  revoke_failed: "Couldn't turn off notifications on this device. Try again.",
};

export function pushClientError(reason: PushClientErrorReason): PushClientError {
  return { reason, message: ERROR_MESSAGES[reason] };
}

/** Narrows a caught `unknown` (e.g. from `subscribeToPush`, which throws `PushClientError`
 *  values rather than generic `Error`s for its own known failure modes) to `PushClientError`. */
export function isPushClientError(value: unknown): value is PushClientError {
  return (
    typeof value === "object" &&
    value !== null &&
    "reason" in value &&
    "message" in value &&
    typeof (value as { reason: unknown }).reason === "string"
  );
}

/** True only in a browser that has every API this feature needs. Never throws. */
export function isPushSupported(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/**
 * Converts the VAPID public key (base64url, as issued) into the raw byte array
 * `PushManager.subscribe()` requires for `applicationServerKey`. Pure and independent of any
 * browser Push API — the standard, widely-used conversion.
 */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export interface NormalizedPushSubscription {
  endpoint: string;
  p256dh: string;
  authKey: string;
}

/**
 * Normalizes a browser `PushSubscription` into the app's own internal shape. The raw object
 * (with its `toJSON()` method and a `keys.auth` field, not `authKey`) is never passed through
 * the application layers — only these three plain strings ever cross the Server Action
 * boundary, matching `pushSubscriptionInputSchema`.
 */
export function normalizeSubscription(subscription: PushSubscription): NormalizedPushSubscription {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) {
    throw new Error("Subscription is missing required fields.");
  }
  return { endpoint: json.endpoint, p256dh, authKey: auth };
}

/**
 * The current subscription for this browser/device, or `null` if there is none — including
 * "no service worker registered yet" (Phase 6.1's normal state before the later SW phase
 * ships), which is not an error, just "nothing to report". Never hangs: uses
 * `getRegistration()`, not `.ready`.
 */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

/**
 * Requests permission (must be called from a real user gesture — this module never calls it on
 * its own) and, once granted, obtains a `PushSubscription` for the given VAPID public key.
 * Reuses an existing subscription if one is already active, rather than minting a new endpoint
 * on every call.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw pushClientError("permission_denied");

  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) throw pushClientError("service_worker_unavailable");

  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;

  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    // The DOM lib's `BufferSource` wants a `Uint8Array<ArrayBuffer>` specifically; the one
    // built above is backed by a plain ArrayBuffer (never a SharedArrayBuffer), so this is a
    // type-system-only mismatch, not a real runtime concern.
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
  });
}
