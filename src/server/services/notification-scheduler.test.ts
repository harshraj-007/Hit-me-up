import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/supabase-service-role", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));
vi.mock("@/server/db/repositories/scheduled-notifications", () => ({
  reconcileAndClaimNotifications: vi.fn(),
}));
vi.mock("./notification-delivery", () => ({ deliverClaimedNotifications: vi.fn() }));
vi.mock("@/server/logging/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
}));

import { createSupabaseServiceRoleClient } from "@/server/db/supabase-service-role";
import { reconcileAndClaimNotifications } from "@/server/db/repositories/scheduled-notifications";
import { deliverClaimedNotifications } from "./notification-delivery";
import { logger } from "@/server/logging/logger";
import { InternalError } from "@/server/errors";
import { runNotificationScheduler } from "./notification-scheduler";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ marker: "client" } as never);
  vi.mocked(deliverClaimedNotifications).mockResolvedValue([]);
});

describe("runNotificationScheduler", () => {
  it("throws a clear InternalError when the service-role client isn't configured, before claiming or delivering anything", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(null);
    await expect(runNotificationScheduler()).rejects.toBeInstanceOf(InternalError);
    expect(reconcileAndClaimNotifications).not.toHaveBeenCalled();
    expect(deliverClaimedNotifications).not.toHaveBeenCalled();
  });

  it("reconciles, claims, then delivers, returning both counts", async () => {
    vi.mocked(reconcileAndClaimNotifications).mockResolvedValue([
      { id: "n1" } as never,
      { id: "n2" } as never,
    ]);
    vi.mocked(deliverClaimedNotifications).mockResolvedValue([
      { notificationId: "n1", delivered: true } as never,
      { notificationId: "n2", delivered: false } as never,
    ]);
    await expect(runNotificationScheduler()).resolves.toEqual({
      claimedCount: 2,
      deliveredCount: 1,
    });
  });

  it("passes the exact claimed rows straight through to delivery, using the same service-role client", async () => {
    const client = { marker: "client" };
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);
    const claimed = [{ id: "n1" } as never];
    vi.mocked(reconcileAndClaimNotifications).mockResolvedValue(claimed);
    await runNotificationScheduler();
    expect(deliverClaimedNotifications).toHaveBeenCalledWith(client, claimed);
  });

  it("still delivers (calling it with an empty list) when nothing was claimed", async () => {
    vi.mocked(reconcileAndClaimNotifications).mockResolvedValue([]);
    await expect(runNotificationScheduler()).resolves.toEqual({
      claimedCount: 0,
      deliveredCount: 0,
    });
    expect(deliverClaimedNotifications).toHaveBeenCalledWith({ marker: "client" }, []);
  });

  it("logs only operational counts — never a task/user payload", async () => {
    vi.mocked(reconcileAndClaimNotifications).mockResolvedValue([{ id: "n1" } as never]);
    vi.mocked(deliverClaimedNotifications).mockResolvedValue([
      { notificationId: "n1", delivered: true } as never,
    ]);
    await runNotificationScheduler();
    expect(logger.info).toHaveBeenCalledWith(expect.any(String), { claimedCount: 1 });
    expect(logger.info).toHaveBeenCalledWith(expect.any(String), {
      claimedCount: 1,
      deliveredCount: 1,
    });
  });

  it("a delivery-layer failure propagates rather than being silently swallowed", async () => {
    vi.mocked(reconcileAndClaimNotifications).mockResolvedValue([{ id: "n1" } as never]);
    vi.mocked(deliverClaimedNotifications).mockRejectedValue(new Error("provider boom"));
    await expect(runNotificationScheduler()).rejects.toThrow("provider boom");
  });
});
