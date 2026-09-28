// HitMeUp service worker — Phase 6.4.
//
// This file is a plain, framework-free, unbundled browser script (Next.js serves everything
// under `public/` verbatim at the site root, so this runs at `/sw.js`; it is never processed by
// the app's TypeScript/webpack pipeline, which is why it is plain JS, not TS, and duplicates no
// imports from `src/`). It is a delivery/UI boundary ONLY — see PROJECT_ARCHITECTURE.md's
// Phase 6.4 section for the full reasoning. It is NOT an authoritative source of task state,
// scheduling, notification timing, authentication, AI decisions, or database state. The
// scheduler (Phase 6.2) and delivery service (Phase 6.3) already own every one of those; this
// file only turns an already-authoritative Push API event into an OS/browser notification, and
// a notification click into same-origin navigation. It holds no credentials of any kind — no
// Supabase client, no service-role key, no VAPID private key, no auth/session token — and makes
// no network requests of its own.

// The only notification kind Phase 6.3 ever sends. Any other value is treated as unsupported.
const SUPPORTED_NOTIFICATION_TYPE = "task_reminder";

// Explicit allowlist, not a same-origin regex check: the payload's `url` is untrusted input (see
// below), and an allowlist of exact, known-safe application destinations is stricter than trying
// to validate a URL's shape (which `javascript:`, `data:`, `blob:`, and protocol-relative URLs
// are all designed to slip past). Phase 6.3 only ever sends "/today"; add a destination here only
// when a real notification kind needs it.
const ALLOWED_NOTIFICATION_URLS = new Set(["/today"]);

function isAllowedNotificationUrl(url) {
  return typeof url === "string" && ALLOWED_NOTIFICATION_URLS.has(url);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Parses and validates a `push` event's data into the one supported notification shape, or
 * returns `null` for anything that isn't exactly that shape. The payload is UNTRUSTED: it did
 * cross a real Web Push provider, but this worker never assumes it is well-formed, safe, or even
 * JSON — a compromised or buggy provider, or a future payload-shape change, must never be able to
 * crash this worker or display arbitrary attacker-controlled content. Nothing here throws;
 * anything unexpected is just treated as "nothing to display".
 */
function parsePushPayload(event) {
  if (!event || !event.data) return null;

  let raw;
  try {
    // `.json()` throws on malformed JSON (or if the underlying bytes can't be read at all) —
    // caught here, not left to become an uncaught rejection inside the `push` handler.
    raw = event.data.json();
  } catch {
    return null;
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.type !== SUPPORTED_NOTIFICATION_TYPE) return null;

  const { notificationId, taskId, title, body, url } = raw;
  if (!isNonEmptyString(notificationId)) return null;
  if (!isNonEmptyString(taskId)) return null;
  if (!isNonEmptyString(title)) return null;
  if (!isNonEmptyString(body)) return null;
  if (!isAllowedNotificationUrl(url)) return null;

  // `scheduledStart` is intentionally not read or validated here: it is informational only
  // (Phase 6.3 puts it in the payload for a possible future use), and this worker must never use
  // it to decide anything about timing — the scheduler already owns that, entirely server-side.

  return { notificationId, taskId, title, body, url };
}

self.addEventListener("install", () => {
  // Nothing to precache, no cache strategy, no offline shell (Phase 6.4 is not a PWA/offline
  // implementation) — the default lifecycle (wait for `activate` before controlling any page) is
  // exactly what this worker wants, so there is nothing to do here beyond letting it happen.
});

self.addEventListener("activate", () => {
  // No `self.clients.claim()`: there is no concrete reason for this worker to aggressively take
  // control of already-open pages, so it does not. A page picks it up on its next load, same as
  // any other service worker's default behavior.
});

self.addEventListener("push", (event) => {
  try {
    const payload = parsePushPayload(event);
    if (!payload) return; // Malformed or unsupported: display nothing, navigate nowhere, throw nothing.

    const promise = self.registration.showNotification(payload.title, {
      body: payload.body,
      // Only what notificationclick needs for validated same-origin navigation. Deliberately
      // excludes everything else the source payload might ever carry (see the module doc
      // comment) — this worker never re-broadcasts more than it needs.
      data: {
        type: SUPPORTED_NOTIFICATION_TYPE,
        notificationId: payload.notificationId,
        taskId: payload.taskId,
        url: payload.url,
      },
    });

    if (event.waitUntil) event.waitUntil(promise);
  } catch {
    // Defensive, outermost guard: nothing in a push event's handling may ever throw uncaught.
  }
});

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  if (notification && typeof notification.close === "function") notification.close();

  const data = notification && notification.data;
  const url = data && data.url;
  if (!isAllowedNotificationUrl(url)) return; // Close only; no navigation for an invalid target.

  const promise = self.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((clientList) => {
      for (const client of clientList) {
        let pathname;
        try {
          pathname = new URL(client.url).pathname;
        } catch {
          continue;
        }
        if (pathname === url && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
      return undefined;
    })
    .catch(() => undefined);

  if (event.waitUntil) event.waitUntil(promise);
});
