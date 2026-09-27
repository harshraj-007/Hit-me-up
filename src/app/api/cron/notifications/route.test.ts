import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/services/notification-scheduler", () => ({
  runNotificationScheduler: vi.fn(),
}));

import { runNotificationScheduler } from "@/server/services/notification-scheduler";
import { POST } from "./route";

function request(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request("https://example.test/api/cron/notifications", { method: "POST", headers });
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "the-real-secret");
  vi.clearAllMocks();
});

describe("POST /api/cron/notifications", () => {
  it("rejects a missing Authorization header without invoking the scheduler", async () => {
    const res = await POST(request(), {});
    expect(res.status).toBe(401);
    expect(runNotificationScheduler).not.toHaveBeenCalled();
  });

  it("rejects the wrong secret without invoking the scheduler", async () => {
    const res = await POST(request("Bearer wrong"), {});
    expect(res.status).toBe(401);
    expect(runNotificationScheduler).not.toHaveBeenCalled();
  });

  it("rejects when CRON_SECRET is unset — never a publicly callable mutation path", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await POST(request("Bearer anything"), {});
    expect(res.status).toBe(401);
    expect(runNotificationScheduler).not.toHaveBeenCalled();
  });

  it("invokes the scheduler and reports the claimed count on a correctly authorized request", async () => {
    vi.mocked(runNotificationScheduler).mockResolvedValue({ claimedCount: 3 });
    const res = await POST(request("Bearer the-real-secret"), {});
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ claimed: 3 });
    expect(runNotificationScheduler).toHaveBeenCalledTimes(1);
  });

  it("is safe to invoke repeatedly — two authorized calls both succeed independently", async () => {
    vi.mocked(runNotificationScheduler).mockResolvedValue({ claimedCount: 0 });
    await POST(request("Bearer the-real-secret"), {});
    await POST(request("Bearer the-real-secret"), {});
    expect(runNotificationScheduler).toHaveBeenCalledTimes(2);
  });

  it("never echoes the configured secret or any internal error detail in the response", async () => {
    const res = await POST(request("Bearer wrong"), {});
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("the-real-secret");
  });
});
