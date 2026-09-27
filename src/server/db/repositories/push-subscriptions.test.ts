import { describe, expect, it, vi } from "vitest";
import { ExternalServiceError } from "@/server/errors";
import { registerPushSubscription, revokePushSubscription } from "./push-subscriptions";

const ROW = {
  id: "sub-1",
  user_id: "user-1",
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  p256dh: "p256dh-value",
  auth_key: "auth-key-value",
  created_at: "2026-09-29T09:00:00.000Z",
  last_seen_at: "2026-09-29T09:00:00.000Z",
  revoked_at: null,
};

function fakeRpc(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => result);
  return { supabase: { rpc } as never, rpc };
}

describe("registerPushSubscription", () => {
  it("maps a well-formed row, including Date conversions", async () => {
    const { supabase } = fakeRpc({ data: ROW, error: null });
    const result = await registerPushSubscription(supabase, {
      endpoint: ROW.endpoint,
      p256dh: ROW.p256dh,
      authKey: ROW.auth_key,
    });
    expect(result).toEqual({
      id: "sub-1",
      userId: "user-1",
      endpoint: ROW.endpoint,
      p256dh: "p256dh-value",
      authKey: "auth-key-value",
      createdAt: new Date("2026-09-29T09:00:00.000Z"),
      lastSeenAt: new Date("2026-09-29T09:00:00.000Z"),
      revokedAt: null,
    });
  });

  it("maps a revoked row's revoked_at to a Date, not null", async () => {
    const { supabase } = fakeRpc({
      data: { ...ROW, revoked_at: "2026-09-29T10:00:00.000Z" },
      error: null,
    });
    const result = await registerPushSubscription(supabase, {
      endpoint: ROW.endpoint,
      p256dh: ROW.p256dh,
      authKey: ROW.auth_key,
    });
    expect(result.revokedAt).toEqual(new Date("2026-09-29T10:00:00.000Z"));
  });

  it("calls the RPC with exactly the three input fields, snake_cased", async () => {
    const { supabase, rpc } = fakeRpc({ data: ROW, error: null });
    await registerPushSubscription(supabase, {
      endpoint: "https://example.com/e",
      p256dh: "p",
      authKey: "a",
    });
    expect(rpc).toHaveBeenCalledWith("register_push_subscription", {
      p_endpoint: "https://example.com/e",
      p_p256dh: "p",
      p_auth_key: "a",
    });
  });

  it("maps a P0002 (endpoint taken by another active subscription) to a friendly, safe message", async () => {
    const { supabase } = fakeRpc({ data: null, error: { code: "P0002", message: "detail" } });
    const error = await registerPushSubscription(supabase, {
      endpoint: ROW.endpoint,
      p256dh: "p",
      authKey: "a",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as Error).message).toBe(
      "This device is already registered elsewhere. Try again in a moment.",
    );
  });

  it("wraps any other database error without leaking its detail", async () => {
    const { supabase } = fakeRpc({
      data: null,
      error: { code: "22023", message: "secret detail" },
    });
    const error = await registerPushSubscription(supabase, {
      endpoint: ROW.endpoint,
      p256dh: "p",
      authKey: "a",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as Error).message).not.toContain("secret detail");
  });
});

describe("revokePushSubscription", () => {
  it("calls the RPC with only the endpoint", async () => {
    const { supabase, rpc } = fakeRpc({ data: null, error: null });
    await revokePushSubscription(supabase, "https://example.com/e");
    expect(rpc).toHaveBeenCalledWith("revoke_push_subscription", {
      p_endpoint: "https://example.com/e",
    });
  });

  it("wraps a database failure", async () => {
    const { supabase } = fakeRpc({ data: null, error: { code: "XX000" } });
    await expect(revokePushSubscription(supabase, "https://example.com/e")).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
  });
});
