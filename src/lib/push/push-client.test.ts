import { describe, expect, it, vi } from "vitest";
import {
  getExistingSubscription,
  isPushClientError,
  isPushSupported,
  normalizeSubscription,
  pushClientError,
  subscribeToPush,
  urlBase64ToUint8Array,
} from "./push-client";

describe("isPushSupported", () => {
  it("is false when there is no window (the default node test environment)", () => {
    expect(isPushSupported()).toBe(false);
  });

  it("is true when serviceWorker, PushManager and Notification are all present", () => {
    vi.stubGlobal("window", { PushManager: class {}, Notification: class {} });
    vi.stubGlobal("navigator", { serviceWorker: {} });
    expect(isPushSupported()).toBe(true);
  });

  it("is false when serviceWorker is missing", () => {
    vi.stubGlobal("window", { PushManager: class {}, Notification: class {} });
    vi.stubGlobal("navigator", {});
    expect(isPushSupported()).toBe(false);
  });

  it("is false when PushManager is missing", () => {
    vi.stubGlobal("window", { Notification: class {} });
    vi.stubGlobal("navigator", { serviceWorker: {} });
    expect(isPushSupported()).toBe(false);
  });

  it("is false when Notification is missing", () => {
    vi.stubGlobal("window", { PushManager: class {} });
    vi.stubGlobal("navigator", { serviceWorker: {} });
    expect(isPushSupported()).toBe(false);
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes a padding-free base64url string to its raw bytes", () => {
    // "SGVsbG8" is the base64url (no padding) form of the ASCII bytes for "Hello".
    expect(Array.from(urlBase64ToUint8Array("SGVsbG8"))).toEqual([72, 101, 108, 108, 111]);
  });

  it("handles base64url's - and _ substitutions for + and /", () => {
    // Bytes [251, 255, 191] base64-encode to "+/+/" family; base64url uses "-_" instead.
    const bytes = urlBase64ToUint8Array("-_-_");
    expect(bytes.length).toBeGreaterThan(0);
    // Round-trip check: re-encoding what we decoded, back through base64 (+/, not -_), matches.
    const reencoded = Buffer.from(bytes).toString("base64");
    expect(reencoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")).toBe("-_-_");
  });
});

function fakeSubscription(json: unknown): PushSubscription {
  return { toJSON: () => json } as unknown as PushSubscription;
}

describe("normalizeSubscription", () => {
  it("maps a well-formed browser subscription into {endpoint, p256dh, authKey}", () => {
    const sub = fakeSubscription({
      endpoint: "https://push.example/e1",
      keys: { p256dh: "P", auth: "A" },
    });
    expect(normalizeSubscription(sub)).toEqual({
      endpoint: "https://push.example/e1",
      p256dh: "P",
      authKey: "A",
    });
  });

  it("never returns a field named `auth` — only the normalized `authKey`", () => {
    const sub = fakeSubscription({ endpoint: "e", keys: { p256dh: "P", auth: "A" } });
    const result = normalizeSubscription(sub) as unknown as Record<string, unknown>;
    expect(result.auth).toBeUndefined();
    expect(result.authKey).toBe("A");
  });

  it.each([
    ["missing endpoint", { keys: { p256dh: "P", auth: "A" } }],
    ["missing keys entirely", { endpoint: "e" }],
    ["missing p256dh", { endpoint: "e", keys: { auth: "A" } }],
    ["missing auth", { endpoint: "e", keys: { p256dh: "P" } }],
  ])("throws on %s rather than silently forwarding an incomplete subscription", (_label, json) => {
    expect(() => normalizeSubscription(fakeSubscription(json))).toThrow();
  });
});

describe("pushClientError / isPushClientError", () => {
  it("returns a fixed, user-safe message for every reason", () => {
    expect(pushClientError("permission_denied").message).toMatch(/permission was denied/i);
    expect(pushClientError("service_worker_unavailable").message).toMatch(/fully set up/i);
  });

  it("isPushClientError recognizes a PushClientError and rejects everything else", () => {
    expect(isPushClientError(pushClientError("unsupported"))).toBe(true);
    expect(isPushClientError(new Error("boom"))).toBe(false);
    expect(isPushClientError(null)).toBe(false);
    expect(isPushClientError("string")).toBe(false);
    expect(isPushClientError({ message: "no reason field" })).toBe(false);
  });
});

describe("getExistingSubscription", () => {
  it("is null when the browser doesn't support push at all (no window)", async () => {
    await expect(getExistingSubscription()).resolves.toBeNull();
  });

  it("is null when there is no service worker registration yet (Phase 6.1's normal state) — and never hangs waiting for one", async () => {
    vi.stubGlobal("window", { PushManager: class {}, Notification: class {} });
    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistration: vi.fn(async () => undefined) },
    });
    await expect(getExistingSubscription()).resolves.toBeNull();
  });

  it("returns the registration's current subscription when one exists", async () => {
    const subscription = fakeSubscription({ endpoint: "e" });
    vi.stubGlobal("window", { PushManager: class {}, Notification: class {} });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn(async () => ({
          pushManager: { getSubscription: vi.fn(async () => subscription) },
        })),
      },
    });
    await expect(getExistingSubscription()).resolves.toBe(subscription);
  });
});

describe("subscribeToPush", () => {
  function stubSupported(overrides: {
    requestPermission?: () => Promise<NotificationPermission>;
    registration?: unknown;
  }) {
    vi.stubGlobal("window", { PushManager: class {}, Notification: class {} });
    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistration: vi.fn(async () => overrides.registration) },
    });
    vi.stubGlobal("Notification", {
      requestPermission: overrides.requestPermission ?? vi.fn(async () => "granted"),
    });
  }

  it("throws permission_denied when the user does not grant permission", async () => {
    stubSupported({
      requestPermission: vi.fn(async (): Promise<NotificationPermission> => "denied"),
    });
    const error = await subscribeToPush("vapid-key").catch((e: unknown) => e);
    expect(isPushClientError(error) && error.reason).toBe("permission_denied");
  });

  it("throws service_worker_unavailable when permission is granted but no worker is registered", async () => {
    stubSupported({ registration: undefined });
    const error = await subscribeToPush("vapid-key").catch((e: unknown) => e);
    expect(isPushClientError(error) && error.reason).toBe("service_worker_unavailable");
  });

  it("reuses an existing subscription instead of subscribing again", async () => {
    const existing = fakeSubscription({ endpoint: "e" });
    const subscribeFn = vi.fn();
    stubSupported({
      registration: {
        pushManager: { getSubscription: vi.fn(async () => existing), subscribe: subscribeFn },
      },
    });
    await expect(subscribeToPush("vapid-key")).resolves.toBe(existing);
    expect(subscribeFn).not.toHaveBeenCalled();
  });

  it("subscribes with userVisibleOnly and the converted application server key when there is no existing subscription", async () => {
    const created = fakeSubscription({ endpoint: "new" });
    const subscribeFn = vi.fn(
      async (_options: PushSubscriptionOptionsInit): Promise<PushSubscription> => created,
    );
    stubSupported({
      registration: {
        pushManager: { getSubscription: vi.fn(async () => undefined), subscribe: subscribeFn },
      },
    });
    await expect(subscribeToPush("SGVsbG8")).resolves.toBe(created);
    expect(subscribeFn).toHaveBeenCalledTimes(1);
    const args = subscribeFn.mock.calls[0]?.[0];
    expect(args?.userVisibleOnly).toBe(true);
    expect(Array.from(args?.applicationServerKey as Uint8Array)).toEqual([72, 101, 108, 108, 111]);
  });
});
