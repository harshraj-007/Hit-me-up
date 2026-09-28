import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `public/sw.js` is a plain, unbundled browser script — Next.js serves it as-is, so there is no
 * TypeScript/webpack step to run it through, and no way to `import` it like an ordinary module.
 * These tests load its REAL source text and execute it inside a Node `vm` sandbox that mocks
 * only the browser/ServiceWorker APIs it touches (`self.addEventListener`,
 * `self.registration.showNotification`, `self.clients.matchAll`/`openWindow`). This exercises
 * the worker's own validation and routing logic exactly as shipped — not a duplicated TS
 * reimplementation of it, and not a test of the Push API/Notification API's own platform
 * behavior (which these mocks intentionally don't simulate beyond what the worker itself reads).
 */

const SW_PATH = path.resolve(import.meta.dirname, "..", "..", "public", "sw.js");
const SW_SOURCE = fs.readFileSync(SW_PATH, "utf8");

type Handler = (event: unknown) => void;
interface Listeners {
  install: Handler[];
  activate: Handler[];
  push: Handler[];
  notificationclick: Handler[];
}

function loadServiceWorker(source: string = SW_SOURCE) {
  const listeners: Listeners = { install: [], activate: [], push: [], notificationclick: [] };
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockResolvedValue([]);
  const openWindow = vi.fn().mockResolvedValue(undefined);

  const selfObj: Record<string, unknown> = {
    addEventListener: (type: keyof Listeners, handler: Handler) => {
      listeners[type].push(handler);
    },
    registration: { showNotification },
    clients: { matchAll, openWindow },
  };

  const sandbox: Record<string, unknown> = { self: selfObj, URL };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "public/sw.js" });

  return { listeners, showNotification, matchAll, openWindow, self: selfObj };
}

/** Fires every registered `push` listener with a fake PushEvent and returns once every promise
 *  passed to `event.waitUntil` has settled (or immediately, if none was). */
async function firePush(listeners: Listeners, data: { json: () => unknown } | null) {
  const waits: unknown[] = [];
  const event = { data, waitUntil: (p: unknown) => waits.push(p) };
  for (const handler of listeners.push) handler(event);
  await Promise.allSettled(waits);
}

/** Fires every `notificationclick` listener with a fake notification and returns
 *  `{ notification, closed }` once any `waitUntil` promise has settled. */
async function fireNotificationClick(
  listeners: Listeners,
  notification: { data?: unknown; close: () => void },
) {
  const waits: unknown[] = [];
  const event = { notification, waitUntil: (p: unknown) => waits.push(p) };
  for (const handler of listeners.notificationclick) handler(event);
  await Promise.allSettled(waits);
}

function fakeNotification(data: unknown) {
  return { data, close: vi.fn() };
}

function omit<T extends Record<string, unknown>>(obj: T, key: keyof T): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...obj };
  delete copy[key as string];
  return copy;
}

const VALID_PAYLOAD = {
  type: "task_reminder",
  notificationId: "notif-1",
  taskId: "task-1",
  title: "Task reminder",
  body: "DSA practice starts in 10 minutes",
  scheduledStart: "2026-09-28T10:00:00.000Z",
  url: "/today",
};

describe("public/sw.js — lifecycle", () => {
  it("registers install, activate, push, and notificationclick handlers", () => {
    const { listeners } = loadServiceWorker();
    expect(listeners.install.length).toBeGreaterThan(0);
    expect(listeners.activate.length).toBeGreaterThan(0);
    expect(listeners.push.length).toBeGreaterThan(0);
    expect(listeners.notificationclick.length).toBeGreaterThan(0);
  });

  it("install and activate never throw and touch no browser API beyond addEventListener", () => {
    const { listeners } = loadServiceWorker();
    for (const handler of listeners.install) expect(() => handler({})).not.toThrow();
    for (const handler of listeners.activate) expect(() => handler({})).not.toThrow();
  });
});

describe("public/sw.js — push: valid payload", () => {
  let env: ReturnType<typeof loadServiceWorker>;
  beforeEach(() => {
    env = loadServiceWorker();
  });

  it("displays a notification with the validated title/body and a safe data object", async () => {
    await firePush(env.listeners, { json: () => VALID_PAYLOAD });
    expect(env.showNotification).toHaveBeenCalledExactlyOnceWith("Task reminder", {
      body: "DSA practice starts in 10 minutes",
      data: {
        type: "task_reminder",
        notificationId: "notif-1",
        taskId: "task-1",
        url: "/today",
      },
    });
  });

  it("never forwards scheduledStart or any other extra field into the notification's data", async () => {
    await firePush(env.listeners, {
      json: () => ({ ...VALID_PAYLOAD, userId: "u1", authToken: "secret", notes: "private" }),
    });
    const options = env.showNotification.mock.calls[0]?.[1] as { data: Record<string, unknown> };
    expect(Object.keys(options.data).sort()).toEqual(["notificationId", "taskId", "type", "url"]);
  });
});

describe("public/sw.js — push: malformed or unsupported payloads", () => {
  let env: ReturnType<typeof loadServiceWorker>;
  beforeEach(() => {
    env = loadServiceWorker();
  });

  it.each([
    ["no event.data at all", null],
    [
      "data.json() throws (invalid JSON)",
      {
        json: () => {
          throw new SyntaxError("bad json");
        },
      },
    ],
    ["data.json() returns null", { json: () => null }],
    ["data.json() returns a non-object", { json: () => "just a string" }],
    ["data.json() returns an array", { json: () => [VALID_PAYLOAD] }],
    [
      "unsupported notification type",
      { json: () => ({ ...VALID_PAYLOAD, type: "marketing_blast" }) },
    ],
    ["missing type entirely", { json: () => omit(VALID_PAYLOAD, "type") }],
    ["missing notificationId", { json: () => omit(VALID_PAYLOAD, "notificationId") }],
    [
      "notificationId is a number, not a string",
      { json: () => ({ ...VALID_PAYLOAD, notificationId: 123 }) },
    ],
    ["missing taskId", { json: () => omit(VALID_PAYLOAD, "taskId") }],
    ["missing title", { json: () => omit(VALID_PAYLOAD, "title") }],
    ["empty-string title", { json: () => ({ ...VALID_PAYLOAD, title: "" }) }],
    ["missing body", { json: () => omit(VALID_PAYLOAD, "body") }],
    ["missing url", { json: () => omit(VALID_PAYLOAD, "url") }],
  ])("does not display a notification for: %s", async (_label, data) => {
    await firePush(env.listeners, data as { json: () => unknown } | null);
    expect(env.showNotification).not.toHaveBeenCalled();
  });

  it("never throws an uncaught error for any malformed payload", async () => {
    for (const handler of env.listeners.push) {
      expect(() =>
        handler({
          data: {
            json: () => {
              throw new Error("boom");
            },
          },
          waitUntil: () => undefined,
        }),
      ).not.toThrow();
    }
  });
});

describe("public/sw.js — push: URL security (allowlist)", () => {
  let env: ReturnType<typeof loadServiceWorker>;
  beforeEach(() => {
    env = loadServiceWorker();
  });

  it("accepts the allowlisted /today destination", async () => {
    await firePush(env.listeners, { json: () => ({ ...VALID_PAYLOAD, url: "/today" }) });
    expect(env.showNotification).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an external origin", "https://evil.example/today"],
    ["a protocol-relative URL", "//evil.example/today"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["blob:", "blob:https://hitmeup.example/1234"],
    ["a same-origin path not on the allowlist", "/settings"],
    ["a non-string URL", 123],
  ])("rejects %s and never calls showNotification", async (_label, url) => {
    await firePush(env.listeners, { json: () => ({ ...VALID_PAYLOAD, url }) });
    expect(env.showNotification).not.toHaveBeenCalled();
  });
});

describe("public/sw.js — notificationclick", () => {
  let env: ReturnType<typeof loadServiceWorker>;
  beforeEach(() => {
    env = loadServiceWorker();
  });

  it("always closes the notification, even for an invalid target", async () => {
    const notification = fakeNotification({ url: "https://evil.example" });
    await fireNotificationClick(env.listeners, notification);
    expect(notification.close).toHaveBeenCalledTimes(1);
  });

  it("focuses an already-open client at the target URL instead of opening a new one", async () => {
    const focus = vi.fn();
    env.matchAll.mockResolvedValue([{ url: "https://hitmeup.example/today", focus }]);
    const notification = fakeNotification({ url: "/today" });
    await fireNotificationClick(env.listeners, notification);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(env.openWindow).not.toHaveBeenCalled();
  });

  it("opens a new window at the validated URL when no matching client is open", async () => {
    env.matchAll.mockResolvedValue([]);
    const notification = fakeNotification({ url: "/today" });
    await fireNotificationClick(env.listeners, notification);
    expect(env.openWindow).toHaveBeenCalledExactlyOnceWith("/today");
  });

  it("never navigates anywhere for a missing data object", async () => {
    const notification = fakeNotification(undefined);
    await fireNotificationClick(env.listeners, notification);
    expect(env.matchAll).not.toHaveBeenCalled();
    expect(env.openWindow).not.toHaveBeenCalled();
  });

  it.each([
    ["an external origin", "https://evil.example/today"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["a protocol-relative URL", "//evil.example/today"],
  ])("never navigates for %s", async (_label, url) => {
    const notification = fakeNotification({ url });
    await fireNotificationClick(env.listeners, notification);
    expect(env.matchAll).not.toHaveBeenCalled();
    expect(env.openWindow).not.toHaveBeenCalled();
  });

  it("never throws for a notification with no close method or malformed data", () => {
    for (const handler of env.listeners.notificationclick) {
      expect(() => handler({ notification: {}, waitUntil: () => undefined })).not.toThrow();
    }
  });
});

// Explanatory comments are allowed to NAME the things this file must never contain (e.g. "no
// Supabase client, no service-role key" in the module doc comment, stating exactly that
// absence) — the same self-matching pitfall Phase 6.3's `delivery-boundaries.test.ts` hit and
// fixed. These checks scan only actual code, with `//` line comments stripped, so a doc comment
// naming a forbidden thing (to say it's absent) can never fail its own check.
const CODE_ONLY = SW_SOURCE.replace(/\/\/.*$/gm, "");

describe("public/sw.js — security/scope boundary", () => {
  it("contains no Supabase, service-role, VAPID private key, or credential-shaped strings in actual code", () => {
    const forbidden = [
      /supabase/i,
      /service[-_]?role/i,
      /vapid_private/i,
      /cron_secret/i,
      /access[-_]?token/i,
      /refresh[-_]?token/i,
      /password/i,
      /importScripts/,
      /indexedDB/,
      /caches\.(open|match)/,
      /XMLHttpRequest/,
    ];
    for (const pattern of forbidden) {
      expect(CODE_ONLY).not.toMatch(pattern);
    }
  });

  it("never calls fetch() — this worker makes no network requests of its own", () => {
    expect(CODE_ONLY).not.toMatch(/[^.]\bfetch\s*\(/);
  });

  it("registers no fetch event handler", () => {
    const { listeners } = loadServiceWorker();
    expect((listeners as unknown as Record<string, unknown[]>).fetch ?? []).toEqual([]);
  });
});
