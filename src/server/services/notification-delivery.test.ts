import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/env.server", () => ({ getWebPushConfig: vi.fn() }));
vi.mock("@/server/notifications/web-push-provider", () => ({ sendWebPush: vi.fn() }));
vi.mock("@/server/db/repositories/tasks", () => ({ getTaskTitleForDelivery: vi.fn() }));
vi.mock("@/server/db/repositories/push-subscriptions", () => ({
  listActiveSubscriptionsForUser: vi.fn(),
  revokePushSubscriptionById: vi.fn(),
}));
vi.mock("@/server/db/repositories/scheduled-notifications", () => ({
  markNotificationSent: vi.fn(),
}));
vi.mock("@/server/logging/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
}));

import { getWebPushConfig } from "@/config/env.server";
import { sendWebPush } from "@/server/notifications/web-push-provider";
import { getTaskTitleForDelivery } from "@/server/db/repositories/tasks";
import {
  listActiveSubscriptionsForUser,
  revokePushSubscriptionById,
} from "@/server/db/repositories/push-subscriptions";
import { markNotificationSent } from "@/server/db/repositories/scheduled-notifications";
import { InternalError } from "@/server/errors";
import type { ScheduledNotification } from "@/server/db/repositories/scheduled-notifications";
import type { PushSubscription } from "@/server/db/repositories/push-subscriptions";
import { FRESH_SUBSCRIPTION_GRACE_MS, deliverClaimedNotifications } from "./notification-delivery";

const CONFIG = { publicKey: "pub", privateKey: "priv", subject: "mailto:test@example.test" };
const SUPABASE = { marker: "service-role-client" } as never;

function makeNotification(over: Partial<ScheduledNotification> = {}): ScheduledNotification {
  return {
    id: "notif-1",
    userId: "user-1",
    taskId: "task-1",
    dayId: "day-1",
    kind: "task_reminder",
    fireAt: new Date("2026-09-30T09:50:00Z"),
    taskScheduledStartSnapshot: new Date("2026-09-30T10:00:00Z"),
    status: "claimed",
    claimedAt: new Date("2026-09-30T09:50:05Z"),
    attemptCount: 1,
    resolvedAt: null,
    createdAt: new Date("2026-09-30T00:00:00Z"),
    updatedAt: new Date("2026-09-30T09:50:05Z"),
    ...over,
  };
}

function makeSubscription(over: Partial<PushSubscription> = {}): PushSubscription {
  const id = over.id ?? "sub-1";
  return {
    id,
    userId: "user-1",
    // Distinct per id by default so tests can branch on `sendWebPush`'s subscription argument
    // (typed as the narrower WebPushSubscriptionInput, which has no `id`) via its endpoint.
    endpoint: `https://push.example/${id}`,
    p256dh: "p256dh-val",
    authKey: "auth-val",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    lastSeenAt: new Date("2026-09-01T00:00:00Z"),
    revokedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWebPushConfig).mockReturnValue(CONFIG);
  vi.mocked(getTaskTitleForDelivery).mockResolvedValue("DSA practice");
});

describe("deliverClaimedNotifications — configuration", () => {
  it("throws a clear InternalError when Web Push isn't configured, before touching anything else", async () => {
    vi.mocked(getWebPushConfig).mockReturnValue(null);
    await expect(
      deliverClaimedNotifications(SUPABASE, [makeNotification()]),
    ).rejects.toBeInstanceOf(InternalError);
    expect(listActiveSubscriptionsForUser).not.toHaveBeenCalled();
  });

  it("does nothing at all for an empty claimed list — no config check, no reads", async () => {
    vi.mocked(getWebPushConfig).mockReturnValue(null);
    await expect(deliverClaimedNotifications(SUPABASE, [])).resolves.toEqual([]);
  });
});

describe("deliverClaimedNotifications — ownership", () => {
  it("scopes the subscription read to the NOTIFICATION's own user_id, from the authoritative row", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([]);
    await deliverClaimedNotifications(SUPABASE, [makeNotification({ userId: "user-42" })]);
    expect(listActiveSubscriptionsForUser).toHaveBeenCalledWith(SUPABASE, "user-42");
  });

  it("never lets one notification's fan-out use a different user's subscriptions", async () => {
    const bySubUser = new Map([
      ["user-a", [makeSubscription({ id: "sub-a", userId: "user-a" })]],
      ["user-b", [makeSubscription({ id: "sub-b", userId: "user-b" })]],
    ]);
    vi.mocked(listActiveSubscriptionsForUser).mockImplementation(
      async (_s, userId: string) => bySubUser.get(userId) ?? [],
    );
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "success", statusCode: 201 });
    await deliverClaimedNotifications(SUPABASE, [
      makeNotification({ id: "n-a", userId: "user-a" }),
      makeNotification({ id: "n-b", userId: "user-b" }),
    ]);
    const targeted = vi.mocked(sendWebPush).mock.calls.map((c) => (c[1] as PushSubscription).id);
    expect(targeted.sort()).toEqual(["sub-a", "sub-b"]);
  });
});

describe("deliverClaimedNotifications — no active subscriptions (case A)", () => {
  it("attempts nothing and does not mark the notification sent", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([]);
    const [outcome] = await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    expect(sendWebPush).not.toHaveBeenCalled();
    expect(markNotificationSent).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ delivered: false, attemptedSubscriptions: 0 });
  });

  it("also does nothing (defensively) when the task itself can no longer be found", async () => {
    vi.mocked(getTaskTitleForDelivery).mockResolvedValue(null);
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([makeSubscription()]);
    const [outcome] = await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    expect(sendWebPush).not.toHaveBeenCalled();
    expect(outcome?.delivered).toBe(false);
  });
});

describe("deliverClaimedNotifications — fan-out", () => {
  it("sends exactly one attempt for one subscription", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([makeSubscription()]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "success", statusCode: 201 });
    await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    expect(sendWebPush).toHaveBeenCalledTimes(1);
  });

  it("sends an independent attempt to every active subscription", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
      makeSubscription({ id: "sub-1" }),
      makeSubscription({ id: "sub-2" }),
      makeSubscription({ id: "sub-3" }),
    ]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "success", statusCode: 201 });
    await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    expect(sendWebPush).toHaveBeenCalledTimes(3);
  });

  it("never targets a revoked subscription — the repository read already filters revoked_at, and delivery trusts it", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
      makeSubscription({ id: "sub-active" }),
    ]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "success", statusCode: 201 });
    await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    expect(vi.mocked(sendWebPush).mock.calls[0]?.[1]).toMatchObject({ id: "sub-active" });
  });

  it("a failure on one subscription does not prevent an attempt on another", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
      makeSubscription({ id: "sub-fails" }),
      makeSubscription({ id: "sub-succeeds" }),
    ]);
    vi.mocked(sendWebPush).mockImplementation(async (_c, sub) =>
      sub.endpoint.includes("sub-fails")
        ? { outcome: "transient_failure", statusCode: 500 }
        : { outcome: "success", statusCode: 201 },
    );
    const [outcome] = await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    expect(sendWebPush).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ successes: 1, transientFailures: 1, delivered: true });
  });
});

describe("deliverClaimedNotifications — permanent failures (404/410)", () => {
  it.each([404, 410])("revokes the subscription on HTTP %s", async (statusCode) => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
      makeSubscription({ id: "sub-dead" }),
    ]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "permanently_invalid", statusCode });
    await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    expect(revokePushSubscriptionById).toHaveBeenCalledWith(SUPABASE, "sub-dead");
  });

  it("a 404/410 on one subscription does not revoke, or affect delivery to, another", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
      makeSubscription({ id: "sub-dead" }),
      makeSubscription({ id: "sub-fine" }),
    ]);
    vi.mocked(sendWebPush).mockImplementation(async (_c, sub) =>
      sub.endpoint.includes("sub-dead")
        ? { outcome: "permanently_invalid", statusCode: 410 }
        : { outcome: "success", statusCode: 201 },
    );
    await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    expect(revokePushSubscriptionById).toHaveBeenCalledTimes(1);
    expect(revokePushSubscriptionById).toHaveBeenCalledWith(SUPABASE, "sub-dead");
    expect(sendWebPush).toHaveBeenCalledTimes(2);
  });

  it("the invalid subscription is revoked (inactive), never deleted — verified via the repository call, not a raw delete", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
      makeSubscription({ id: "sub-dead" }),
    ]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "permanently_invalid", statusCode: 410 });
    await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    expect(revokePushSubscriptionById).toHaveBeenCalledWith(SUPABASE, "sub-dead");
    // The repository's own revoke path sets revoked_at; nothing here calls anything delete-shaped.
  });
});

describe("deliverClaimedNotifications — transient failures (429/5xx/timeout)", () => {
  it.each([429, 500, 503])("does NOT revoke the subscription on HTTP %s", async (statusCode) => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([makeSubscription()]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "transient_failure", statusCode });
    await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    expect(revokePushSubscriptionById).not.toHaveBeenCalled();
  });

  it("does not revoke on a network-level failure (no status code at all)", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([makeSubscription()]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "transient_failure" });
    await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    expect(revokePushSubscriptionById).not.toHaveBeenCalled();
  });

  it("leaves the notification claimed (does not mark sent) when every attempt is transient — Phase 6.2's lease recovery decides its fate", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([makeSubscription()]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "transient_failure", statusCode: 500 });
    const [outcome] = await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    expect(markNotificationSent).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ delivered: false, transientFailures: 1 });
  });
});

describe("deliverClaimedNotifications — success (2xx is acceptance, not proof of display)", () => {
  it("marks the notification sent on a successful provider acceptance", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([makeSubscription()]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "success", statusCode: 201 });
    await deliverClaimedNotifications(SUPABASE, [makeNotification({ id: "notif-x" })]);
    expect(markNotificationSent).toHaveBeenCalledWith(SUPABASE, "notif-x");
  });

  it("the returned outcome never claims the user saw anything — it only reports provider acceptance counts", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([makeSubscription()]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "success", statusCode: 201 });
    const [outcome] = await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    expect(Object.keys(outcome ?? {})).not.toContain("seen");
    expect(Object.keys(outcome ?? {})).not.toContain("displayed");
    expect(Object.keys(outcome ?? {})).not.toContain("userSaw");
  });
});

describe("deliverClaimedNotifications — mixed results", () => {
  it("one success + one 410: marks sent AND revokes the invalid one", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
      makeSubscription({ id: "sub-ok" }),
      makeSubscription({ id: "sub-dead" }),
    ]);
    vi.mocked(sendWebPush).mockImplementation(async (_c, sub) =>
      sub.endpoint.includes("sub-ok")
        ? { outcome: "success", statusCode: 201 }
        : { outcome: "permanently_invalid", statusCode: 410 },
    );
    const [outcome] = await deliverClaimedNotifications(SUPABASE, [
      makeNotification({ id: "notif-mix" }),
    ]);
    expect(markNotificationSent).toHaveBeenCalledWith(SUPABASE, "notif-mix");
    expect(revokePushSubscriptionById).toHaveBeenCalledWith(SUPABASE, "sub-dead");
    expect(outcome).toMatchObject({ successes: 1, permanentlyInvalid: 1, delivered: true });
  });

  it("one success + one transient failure: marks sent, does not revoke the transient one", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
      makeSubscription({ id: "sub-ok" }),
      makeSubscription({ id: "sub-slow" }),
    ]);
    vi.mocked(sendWebPush).mockImplementation(async (_c, sub) =>
      sub.endpoint.includes("sub-ok")
        ? { outcome: "success", statusCode: 201 }
        : { outcome: "transient_failure", statusCode: 503 },
    );
    await deliverClaimedNotifications(SUPABASE, [makeNotification({ id: "notif-mix2" })]);
    expect(markNotificationSent).toHaveBeenCalledWith(SUPABASE, "notif-mix2");
    expect(revokePushSubscriptionById).not.toHaveBeenCalled();
  });

  it("all subscriptions permanently invalid: revokes each, does not mark sent (no infinite loop — the row is left for Phase 6.2's attempt cap)", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
      makeSubscription({ id: "sub-1" }),
      makeSubscription({ id: "sub-2" }),
    ]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "permanently_invalid", statusCode: 410 });
    const [outcome] = await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    expect(revokePushSubscriptionById).toHaveBeenCalledTimes(2);
    expect(markNotificationSent).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ delivered: false, permanentlyInvalid: 2 });
  });

  it("all transient: remains retryable (not marked sent, not revoked)", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
      makeSubscription({ id: "sub-1" }),
      makeSubscription({ id: "sub-2" }),
    ]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "transient_failure", statusCode: 429 });
    const [outcome] = await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    expect(markNotificationSent).not.toHaveBeenCalled();
    expect(revokePushSubscriptionById).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ delivered: false, transientFailures: 2 });
  });
});

describe("deliverClaimedNotifications — multiple claimed notifications in one cron cycle", () => {
  it("processes each claimed notification independently and returns one outcome per notification", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([makeSubscription()]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "success", statusCode: 201 });
    const outcomes = await deliverClaimedNotifications(SUPABASE, [
      makeNotification({ id: "n1" }),
      makeNotification({ id: "n2" }),
    ]);
    expect(outcomes.map((o) => o.notificationId)).toEqual(["n1", "n2"]);
    expect(markNotificationSent).toHaveBeenCalledTimes(2);
  });

  it("a provider failure on one notification does not corrupt or block processing of another", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([makeSubscription()]);
    vi.mocked(sendWebPush).mockImplementation(async (_c, _s, payload) =>
      (payload as { notificationId: string }).notificationId === "n-bad"
        ? { outcome: "transient_failure", statusCode: 500 }
        : { outcome: "success", statusCode: 201 },
    );
    const outcomes = await deliverClaimedNotifications(SUPABASE, [
      makeNotification({ id: "n-bad" }),
      makeNotification({ id: "n-good" }),
    ]);
    expect(outcomes.find((o) => o.notificationId === "n-bad")?.delivered).toBe(false);
    expect(outcomes.find((o) => o.notificationId === "n-good")?.delivered).toBe(true);
  });
});

describe("deliverClaimedNotifications — payload never leaks task notes or identity fields", () => {
  it("passes web-push only the deterministic payload shape, never the raw task/notification row", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([makeSubscription()]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "success", statusCode: 201 });
    await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    const payload = vi.mocked(sendWebPush).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload.userId).toBeUndefined();
    expect(payload.notes).toBeUndefined();
    expect(payload).toMatchObject({ type: "task_reminder", title: "Task reminder" });
  });
});

describe("deliverClaimedNotifications — a freshly registered subscription's 404/410 is not believed yet", () => {
  // Real-push-service behavior found by end-to-end verification: a brand-new registration answers 410 for
  // a few seconds, then 201. Revoking it on that first answer silently drops a working subscription.
  const NOW = new Date("2026-10-06T12:00:00Z");
  const now = () => NOW;
  const ago = (ms: number) => new Date(NOW.getTime() - ms);

  it.each([404, 410])(
    "HTTP %s inside the grace window: NOT revoked, counted as transient, notification left retryable",
    async (statusCode) => {
      vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
        makeSubscription({ id: "sub-new", lastSeenAt: ago(5_000) }),
      ]);
      vi.mocked(sendWebPush).mockResolvedValue({ outcome: "permanently_invalid", statusCode });
      const [outcome] = await deliverClaimedNotifications(SUPABASE, [makeNotification()], { now });
      expect(revokePushSubscriptionById).not.toHaveBeenCalled();
      expect(markNotificationSent).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        delivered: false,
        permanentlyInvalid: 0,
        transientFailures: 1,
      });
    },
  );

  it("the window's edge: just inside is not believed, exactly at it (and beyond) is", async () => {
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "permanently_invalid", statusCode: 410 });

    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
      makeSubscription({ id: "sub-edge", lastSeenAt: ago(FRESH_SUBSCRIPTION_GRACE_MS - 1) }),
    ]);
    await deliverClaimedNotifications(SUPABASE, [makeNotification()], { now });
    expect(revokePushSubscriptionById).not.toHaveBeenCalled();

    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
      makeSubscription({ id: "sub-edge", lastSeenAt: ago(FRESH_SUBSCRIPTION_GRACE_MS) }),
    ]);
    await deliverClaimedNotifications(SUPABASE, [makeNotification()], { now });
    expect(revokePushSubscriptionById).toHaveBeenCalledExactlyOnceWith(SUPABASE, "sub-edge");
  });

  it("an old dead subscription is still revoked in the same fan-out as a fresh one that is not", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
      makeSubscription({ id: "sub-old-dead", lastSeenAt: ago(60 * 60_000) }),
      makeSubscription({ id: "sub-new-gone", lastSeenAt: ago(3_000) }),
      makeSubscription({ id: "sub-live", lastSeenAt: ago(60 * 60_000) }),
    ]);
    vi.mocked(sendWebPush).mockImplementation(async (_c, sub) =>
      sub.endpoint.includes("live")
        ? { outcome: "success", statusCode: 201 }
        : { outcome: "permanently_invalid", statusCode: 410 },
    );
    const [outcome] = await deliverClaimedNotifications(SUPABASE, [makeNotification()], { now });
    expect(revokePushSubscriptionById).toHaveBeenCalledExactlyOnceWith(SUPABASE, "sub-old-dead");
    expect(outcome).toMatchObject({
      delivered: true,
      successes: 1,
      permanentlyInvalid: 1,
      transientFailures: 1,
    });
  });

  it("a freshly re-registered OLD row counts as fresh (re-registration refreshes last_seen_at)", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
      makeSubscription({
        id: "sub-reenabled",
        createdAt: ago(30 * 24 * 60 * 60_000),
        lastSeenAt: ago(2_000),
      }),
    ]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "permanently_invalid", statusCode: 410 });
    await deliverClaimedNotifications(SUPABASE, [makeNotification()], { now });
    expect(revokePushSubscriptionById).not.toHaveBeenCalled();
  });

  it("does not affect a fresh subscription that succeeds", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
      makeSubscription({ id: "sub-new", lastSeenAt: ago(1_000) }),
    ]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "success", statusCode: 201 });
    const [outcome] = await deliverClaimedNotifications(SUPABASE, [makeNotification()], { now });
    expect(outcome).toMatchObject({ delivered: true, successes: 1 });
    expect(markNotificationSent).toHaveBeenCalledTimes(1);
  });

  it("uses the real clock by default (a subscription registered just now is fresh)", async () => {
    vi.mocked(listActiveSubscriptionsForUser).mockResolvedValue([
      makeSubscription({ id: "sub-now", lastSeenAt: new Date() }),
    ]);
    vi.mocked(sendWebPush).mockResolvedValue({ outcome: "permanently_invalid", statusCode: 410 });
    await deliverClaimedNotifications(SUPABASE, [makeNotification()]);
    expect(revokePushSubscriptionById).not.toHaveBeenCalled();
  });
});
