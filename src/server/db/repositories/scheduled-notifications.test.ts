import { describe, expect, it, vi } from "vitest";
import { ExternalServiceError } from "@/server/errors";
import { reconcileAndClaimNotifications } from "./scheduled-notifications";

const ROW = {
  id: "notif-1",
  user_id: "user-1",
  task_id: "task-1",
  day_id: "day-1",
  kind: "task_reminder",
  fire_at: "2026-09-30T09:50:00.000Z",
  task_scheduled_start_snapshot: "2026-09-30T10:00:00.000Z",
  status: "claimed",
  claimed_at: "2026-09-30T09:50:05.000Z",
  attempt_count: 1,
  resolved_at: null,
  created_at: "2026-09-30T00:00:00.000Z",
  updated_at: "2026-09-30T09:50:05.000Z",
};

function fakeRpc(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => result);
  return { supabase: { rpc } as never, rpc };
}

describe("reconcileAndClaimNotifications", () => {
  it("maps claimed rows, including Date conversions and a null resolvedAt", async () => {
    const { supabase } = fakeRpc({ data: [ROW], error: null });
    const result = await reconcileAndClaimNotifications(supabase);
    expect(result).toEqual([
      {
        id: "notif-1",
        userId: "user-1",
        taskId: "task-1",
        dayId: "day-1",
        kind: "task_reminder",
        fireAt: new Date("2026-09-30T09:50:00.000Z"),
        taskScheduledStartSnapshot: new Date("2026-09-30T10:00:00.000Z"),
        status: "claimed",
        claimedAt: new Date("2026-09-30T09:50:05.000Z"),
        attemptCount: 1,
        resolvedAt: null,
        createdAt: new Date("2026-09-30T00:00:00.000Z"),
        updatedAt: new Date("2026-09-30T09:50:05.000Z"),
      },
    ]);
  });

  it("maps a resolved row's resolvedAt to a Date, not null", async () => {
    const { supabase } = fakeRpc({
      data: [{ ...ROW, status: "expired", resolved_at: "2026-09-30T10:00:00.000Z" }],
      error: null,
    });
    const [result] = await reconcileAndClaimNotifications(supabase);
    expect(result?.resolvedAt).toEqual(new Date("2026-09-30T10:00:00.000Z"));
  });

  it("returns an empty array when nothing was claimed (null data)", async () => {
    const { supabase } = fakeRpc({ data: null, error: null });
    await expect(reconcileAndClaimNotifications(supabase)).resolves.toEqual([]);
  });

  it("calls the RPC with no arguments", async () => {
    const { supabase, rpc } = fakeRpc({ data: [], error: null });
    await reconcileAndClaimNotifications(supabase);
    expect(rpc).toHaveBeenCalledWith("reconcile_and_claim_notifications");
  });

  it("wraps a database failure without leaking its detail", async () => {
    const { supabase } = fakeRpc({ data: null, error: { code: "42501", message: "secret" } });
    const error = await reconcileAndClaimNotifications(supabase).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as Error).message).not.toContain("secret");
  });
});
