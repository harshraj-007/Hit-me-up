import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/supabase-service-role", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));
vi.mock("@/server/db/repositories/scheduled-notifications", () => ({
  reconcileAndClaimNotifications: vi.fn(),
}));
vi.mock("@/server/logging/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
}));

import { createSupabaseServiceRoleClient } from "@/server/db/supabase-service-role";
import { reconcileAndClaimNotifications } from "@/server/db/repositories/scheduled-notifications";
import { logger } from "@/server/logging/logger";
import { InternalError } from "@/server/errors";
import { runNotificationScheduler } from "./notification-scheduler";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runNotificationScheduler", () => {
  it("throws a clear InternalError when the service-role client isn't configured", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(null);
    await expect(runNotificationScheduler()).rejects.toBeInstanceOf(InternalError);
    expect(reconcileAndClaimNotifications).not.toHaveBeenCalled();
  });

  it("reconciles and claims, returning only a count", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ marker: "client" } as never);
    vi.mocked(reconcileAndClaimNotifications).mockResolvedValue([
      { id: "n1" } as never,
      { id: "n2" } as never,
    ]);
    await expect(runNotificationScheduler()).resolves.toEqual({ claimedCount: 2 });
  });

  it("logs only an operational count — never a task/user payload", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ marker: "client" } as never);
    vi.mocked(reconcileAndClaimNotifications).mockResolvedValue([{ id: "n1" } as never]);
    await runNotificationScheduler();
    expect(logger.info).toHaveBeenCalledWith(expect.any(String), { claimedCount: 1 });
  });

  it("passes the service-role client straight through to the repository", async () => {
    const client = { marker: "client" };
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);
    vi.mocked(reconcileAndClaimNotifications).mockResolvedValue([]);
    await runNotificationScheduler();
    expect(reconcileAndClaimNotifications).toHaveBeenCalledWith(client);
  });
});
