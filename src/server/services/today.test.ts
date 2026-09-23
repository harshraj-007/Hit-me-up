import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/server/db/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({})),
}));
vi.mock("@/server/db/repositories/plans", () => ({ ensurePlan: vi.fn() }));
vi.mock("@/server/db/repositories/tasks", () => ({ listTasksForDay: vi.fn() }));
vi.mock("@/server/db/repositories/briefings", () => ({ getLatestBriefing: vi.fn() }));
vi.mock("./day", () => ({ findCurrentDay: vi.fn() }));

import { requireUser } from "@/server/auth/session";
import { ensurePlan } from "@/server/db/repositories/plans";
import { listTasksForDay } from "@/server/db/repositories/tasks";
import { getLatestBriefing } from "@/server/db/repositories/briefings";
import { findCurrentDay } from "./day";
import { getTodaySnapshot } from "./today";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({ id: "user-1", email: null });
});

describe("getTodaySnapshot", () => {
  it("returns needs-timezone and creates/reads nothing further when the timezone is unknown", async () => {
    vi.mocked(findCurrentDay).mockResolvedValue(null);

    await expect(getTodaySnapshot()).resolves.toEqual({ kind: "needs-timezone" });

    expect(ensurePlan).not.toHaveBeenCalled();
    expect(listTasksForDay).not.toHaveBeenCalled();
    expect(getLatestBriefing).not.toHaveBeenCalled();
  });

  it("returns a ready snapshot for the resolved day once the timezone is known", async () => {
    vi.mocked(findCurrentDay).mockResolvedValue({
      id: "day-1",
      userId: "user-1",
      localDate: "2026-09-24",
      timezone: "Asia/Calcutta",
    });
    vi.mocked(listTasksForDay).mockResolvedValue([]);
    vi.mocked(getLatestBriefing).mockResolvedValue(null);

    const snapshot = await getTodaySnapshot();

    expect(snapshot).toMatchObject({
      kind: "ready",
      dayId: "day-1",
      localDate: "2026-09-24",
      tasks: [],
    });
    expect(ensurePlan).toHaveBeenCalledWith(expect.anything(), "user-1", "day-1");
  });
});
