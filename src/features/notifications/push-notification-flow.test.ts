import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/server/errors";
import { pushClientError, type NormalizedPushSubscription } from "@/lib/push/push-client";
import {
  canStartDisable,
  canStartEnable,
  runDisableFlow,
  runEnableFlow,
  stateAfterDisable,
  stateAfterMountCheck,
  type PushNotificationsState,
} from "./push-notification-flow";

const NORMALIZED: NormalizedPushSubscription = {
  endpoint: "https://push.example/e1",
  p256dh: "P",
  authKey: "A",
};

function fakeSubscription(endpoint = "https://push.example/e1"): PushSubscription {
  return { endpoint, unsubscribe: vi.fn(async () => true) } as unknown as PushSubscription;
}

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}
function err(message: string): ActionResult<never> {
  return { ok: false, error: { code: "INTERNAL_ERROR", message, requestId: "req-1" } };
}

describe("stateAfterMountCheck", () => {
  const base = {
    supported: true,
    vapidConfigured: true,
    permission: "default" as const,
    hasExistingSubscription: false,
  };

  it("is unsupported when the browser lacks support, regardless of everything else", () => {
    expect(stateAfterMountCheck({ ...base, supported: false, vapidConfigured: false })).toBe(
      "unsupported",
    );
    expect(
      stateAfterMountCheck({
        ...base,
        supported: false,
        permission: "granted",
        hasExistingSubscription: true,
      }),
    ).toBe("unsupported");
  });

  it("is not_configured when supported but no VAPID key, regardless of permission/subscription", () => {
    expect(stateAfterMountCheck({ ...base, vapidConfigured: false })).toBe("not_configured");
    expect(stateAfterMountCheck({ ...base, vapidConfigured: false, permission: "denied" })).toBe(
      "not_configured",
    );
  });

  it("is permission_denied when permission is denied, regardless of subscription state", () => {
    expect(stateAfterMountCheck({ ...base, permission: "denied" })).toBe("permission_denied");
    expect(
      stateAfterMountCheck({ ...base, permission: "denied", hasExistingSubscription: true }),
    ).toBe("permission_denied");
  });

  it("is enabled when a subscription already exists (permission default or granted)", () => {
    expect(stateAfterMountCheck({ ...base, hasExistingSubscription: true })).toBe("enabled");
    expect(
      stateAfterMountCheck({ ...base, permission: "granted", hasExistingSubscription: true }),
    ).toBe("enabled");
  });

  it("is permission_default when permission is undecided and no subscription exists", () => {
    expect(stateAfterMountCheck({ ...base, permission: "default" })).toBe("permission_default");
  });

  it("is permission_granted — NOT enabled — when permission is granted but no subscription exists", () => {
    expect(stateAfterMountCheck({ ...base, permission: "granted" })).toBe("permission_granted");
  });

  it("never calls a browser API — it is a pure function of its input", () => {
    // Structural guarantee, not just a runtime check: this file imports nothing from
    // `lib/push/push-client` or the DOM lib's ambient globals, so there is nothing for this
    // function to call even if it wanted to. `mount alone does not request permission`
    // (Phase 6.5 section 2/15.B) is enforced by construction, not by a stub returning undefined.
    expect(stateAfterMountCheck(base)).toBe("permission_default");
  });
});

describe("canStartEnable / canStartDisable", () => {
  const allStates: PushNotificationsState[] = [
    "checking",
    "unsupported",
    "not_configured",
    "permission_denied",
    "permission_default",
    "permission_granted",
    "subscribing",
    "registering",
    "enabled",
    "revoking",
    "error",
  ];

  it("canStartEnable is true only for permission_default, permission_granted and error", () => {
    for (const state of allStates) {
      expect(canStartEnable(state)).toBe(
        state === "permission_default" || state === "permission_granted" || state === "error",
      );
    }
  });

  it("canStartDisable is true only for enabled", () => {
    for (const state of allStates) {
      expect(canStartDisable(state)).toBe(state === "enabled");
    }
  });
});

describe("stateAfterDisable", () => {
  it("returns to permission_granted when the browser permission is still granted", () => {
    expect(stateAfterDisable("granted")).toBe("permission_granted");
  });
  it("returns to permission_default when permission is undecided", () => {
    expect(stateAfterDisable("default")).toBe("permission_default");
  });
  it("lands on permission_denied if the user has since blocked notifications", () => {
    expect(stateAfterDisable("denied")).toBe("permission_denied");
  });
});

describe("runEnableFlow", () => {
  function deps(overrides: Partial<Parameters<typeof runEnableFlow>[1]> = {}) {
    return {
      subscribeToPush: vi.fn(async () => fakeSubscription()),
      normalizeSubscription: vi.fn(() => NORMALIZED),
      registerPushSubscriptionAction: vi.fn(async () => ok(undefined)),
      ...overrides,
    };
  }

  it("reports subscribing then registering, in that order, before success", async () => {
    const phases: string[] = [];
    await runEnableFlow("vapid-key", deps(), (phase) => phases.push(phase));
    expect(phases).toEqual(["subscribing", "registering"]);
  });

  it("passes the VAPID key through to subscribeToPush unchanged", async () => {
    const d = deps();
    await runEnableFlow("the-vapid-key", d, () => undefined);
    expect(d.subscribeToPush).toHaveBeenCalledExactlyOnceWith("the-vapid-key");
  });

  it("succeeds only after registerPushSubscriptionAction itself returns ok", async () => {
    const d = deps();
    const outcome = await runEnableFlow("k", d, () => undefined);
    expect(outcome).toEqual({ kind: "enabled" });
    expect(d.registerPushSubscriptionAction).toHaveBeenCalledExactlyOnceWith(NORMALIZED);
  });

  it("reuses an existing subscription rather than creating a new one — delegated entirely to subscribeToPush, never re-implemented here", async () => {
    const existing = fakeSubscription("https://push.example/existing");
    const d = deps({ subscribeToPush: vi.fn(async () => existing) });
    await runEnableFlow("k", d, () => undefined);
    expect(d.normalizeSubscription).toHaveBeenCalledExactlyOnceWith(existing);
  });

  it("maps a permission_denied PushClientError to the permission_denied outcome, not error", async () => {
    const d = deps({
      subscribeToPush: vi.fn(async () => {
        throw pushClientError("permission_denied");
      }),
    });
    const outcome = await runEnableFlow("k", d, () => undefined);
    expect(outcome.kind).toBe("permission_denied");
    expect(outcome).toHaveProperty("message");
    expect(d.normalizeSubscription).not.toHaveBeenCalled();
    expect(d.registerPushSubscriptionAction).not.toHaveBeenCalled();
  });

  it("maps every other PushClientError (e.g. service_worker_unavailable) to a generic error outcome", async () => {
    const d = deps({
      subscribeToPush: vi.fn(async () => {
        throw pushClientError("service_worker_unavailable");
      }),
    });
    const outcome = await runEnableFlow("k", d, () => undefined);
    expect(outcome.kind).toBe("error");
  });

  it("never claims enabled when subscribeToPush throws something unexpected, and never leaks the raw error", async () => {
    const d = deps({
      subscribeToPush: vi.fn(async () => {
        throw new Error("some raw browser/network detail that must never reach the UI");
      }),
    });
    const outcome = await runEnableFlow("k", d, () => undefined);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).not.toMatch(/raw browser\/network detail/);
    }
  });

  it("never claims enabled when normalizeSubscription throws", async () => {
    const d = deps({
      normalizeSubscription: vi.fn(() => {
        throw new Error("missing keys");
      }),
    });
    const outcome = await runEnableFlow("k", d, () => undefined);
    expect(outcome.kind).toBe("error");
    expect(d.registerPushSubscriptionAction).not.toHaveBeenCalled();
  });

  it("never claims enabled when the server registration fails, and forwards its user-safe message", async () => {
    const d = deps({
      registerPushSubscriptionAction: vi.fn(async () => err("Couldn't save your subscription.")),
    });
    const outcome = await runEnableFlow("k", d, () => undefined);
    expect(outcome).toEqual({ kind: "error", message: "Couldn't save your subscription." });
  });
});

describe("runDisableFlow", () => {
  it("revokes server-side then unsubscribes in the browser when a subscription exists", async () => {
    const subscription = fakeSubscription();
    const revokeAction = vi.fn(async () => ok(undefined));
    const outcome = await runDisableFlow({
      getExistingSubscription: vi.fn(async () => subscription),
      revokePushSubscriptionAction: revokeAction,
    });
    expect(outcome).toEqual({ kind: "disabled" });
    expect(revokeAction).toHaveBeenCalledExactlyOnceWith({ endpoint: subscription.endpoint });
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("is a no-op success when there is no existing subscription to revoke", async () => {
    const revokeAction = vi.fn(async () => ok(undefined));
    const outcome = await runDisableFlow({
      getExistingSubscription: vi.fn(async () => null),
      revokePushSubscriptionAction: revokeAction,
    });
    expect(outcome).toEqual({ kind: "disabled" });
    expect(revokeAction).not.toHaveBeenCalled();
  });

  it("does not unsubscribe in the browser when the server-side revoke fails", async () => {
    const subscription = fakeSubscription();
    const outcome = await runDisableFlow({
      getExistingSubscription: vi.fn(async () => subscription),
      revokePushSubscriptionAction: vi.fn(async () => err("Couldn't turn off notifications.")),
    });
    expect(outcome).toEqual({ kind: "error", message: "Couldn't turn off notifications." });
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });

  it("never throws — an unexpected failure becomes a user-safe error outcome", async () => {
    const outcome = await runDisableFlow({
      getExistingSubscription: vi.fn(async () => {
        throw new Error("raw detail");
      }),
      revokePushSubscriptionAction: vi.fn(async () => ok(undefined)),
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.message).not.toMatch(/raw detail/);
  });
});
