import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", () => ({ requireUserForAction: vi.fn() }));
vi.mock("@/server/db/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({ marker: "supabase" })),
}));
vi.mock("@/server/db/repositories/push-subscriptions", () => ({
  registerPushSubscription: vi.fn(),
  revokePushSubscription: vi.fn(),
}));

import { requireUserForAction } from "@/server/auth/session";
import {
  registerPushSubscription as registerPushSubscriptionRpc,
  revokePushSubscription as revokePushSubscriptionRpc,
} from "@/server/db/repositories/push-subscriptions";
import { AuthenticationError } from "@/server/errors";
import { registerPushSubscription, revokePushSubscription } from "./push-subscriptions";

const VALID = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  p256dh: "p".repeat(20),
  authKey: "a".repeat(12),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUserForAction).mockResolvedValue({ id: "user-1", email: null });
});

describe("registerPushSubscription", () => {
  it("requires authentication before doing anything else", async () => {
    vi.mocked(requireUserForAction).mockRejectedValue(new AuthenticationError());
    await expect(registerPushSubscription(VALID)).rejects.toBeInstanceOf(AuthenticationError);
    expect(registerPushSubscriptionRpc).not.toHaveBeenCalled();
  });

  it("passes the validated, normalized fields straight through to the repository", async () => {
    await registerPushSubscription(VALID);
    expect(registerPushSubscriptionRpc).toHaveBeenCalledWith(
      { marker: "supabase" },
      { endpoint: VALID.endpoint, p256dh: VALID.p256dh, authKey: VALID.authKey },
    );
  });

  it("rejects malformed input before ever reaching the repository", async () => {
    await expect(registerPushSubscription({ ...VALID, endpoint: "not-a-url" })).rejects.toThrow();
    expect(registerPushSubscriptionRpc).not.toHaveBeenCalled();
  });

  it("a client cannot supply userId (or any other field) to influence ownership", async () => {
    await expect(
      registerPushSubscription({ ...VALID, userId: "attacker-controlled" }),
    ).rejects.toThrow();
    expect(registerPushSubscriptionRpc).not.toHaveBeenCalled();
  });
});

describe("revokePushSubscription", () => {
  it("requires authentication before doing anything else", async () => {
    vi.mocked(requireUserForAction).mockRejectedValue(new AuthenticationError());
    await expect(revokePushSubscription({ endpoint: VALID.endpoint })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(revokePushSubscriptionRpc).not.toHaveBeenCalled();
  });

  it("passes only the endpoint to the repository", async () => {
    await revokePushSubscription({ endpoint: VALID.endpoint });
    expect(revokePushSubscriptionRpc).toHaveBeenCalledWith({ marker: "supabase" }, VALID.endpoint);
  });

  it("a client cannot supply userId alongside the endpoint", async () => {
    await expect(
      revokePushSubscription({ endpoint: VALID.endpoint, userId: "attacker-controlled" }),
    ).rejects.toThrow();
    expect(revokePushSubscriptionRpc).not.toHaveBeenCalled();
  });

  it("rejects a missing endpoint", async () => {
    await expect(revokePushSubscription({})).rejects.toThrow();
    expect(revokePushSubscriptionRpc).not.toHaveBeenCalled();
  });
});
