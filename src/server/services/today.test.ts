import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/server/db/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({})),
}));
vi.mock("@/server/db/repositories/tasks", () => ({
  listTasksForDay: vi.fn(),
  listSpilloverTasks: vi.fn(),
}));
vi.mock("@/server/db/repositories/briefings", () => ({ getLatestBriefing: vi.fn() }));
vi.mock("@/server/db/repositories/ai-proposals", () => ({ findPendingProposal: vi.fn() }));
vi.mock("@/server/db/repositories/plans", () => ({ getLatestRevisionNumber: vi.fn() }));
vi.mock("./day", () => ({ findCurrentDay: vi.fn(), todayLocalDate: vi.fn(), viewDay: vi.fn() }));
vi.mock("./eod-report", () => ({ loadEodReportView: vi.fn() }));

import { requireUser } from "@/server/auth/session";
import { listSpilloverTasks, listTasksForDay } from "@/server/db/repositories/tasks";
import { getLatestBriefing } from "@/server/db/repositories/briefings";
import { findPendingProposal } from "@/server/db/repositories/ai-proposals";
import { getLatestRevisionNumber } from "@/server/db/repositories/plans";
import { findCurrentDay, todayLocalDate, viewDay } from "./day";
import { loadEodReportView } from "./eod-report";
import { getTodaySnapshot } from "./today";

const TODAY = { id: "day-1", userId: "user-1", localDate: "2026-09-24", timezone: "Asia/Calcutta" };
const YESTERDAY = {
  id: "day-0",
  userId: "user-1",
  localDate: "2026-09-23",
  timezone: "Asia/Calcutta",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({ id: "user-1", email: null });
  vi.mocked(todayLocalDate).mockResolvedValue({
    todayLocal: "2026-09-24",
    profileTimezone: "Asia/Calcutta",
  });
  vi.mocked(findCurrentDay).mockResolvedValue(TODAY);
  vi.mocked(viewDay).mockResolvedValue(null);
  vi.mocked(listTasksForDay).mockResolvedValue([]);
  vi.mocked(listSpilloverTasks).mockResolvedValue([]);
  vi.mocked(getLatestBriefing).mockResolvedValue(null);
  vi.mocked(findPendingProposal).mockResolvedValue(null);
  vi.mocked(getLatestRevisionNumber).mockResolvedValue(1);
  vi.mocked(loadEodReportView).mockResolvedValue(null);
});

describe("getTodaySnapshot", () => {
  it("returns needs-timezone and reads/creates nothing further when the timezone is unknown", async () => {
    vi.mocked(todayLocalDate).mockResolvedValue(null);
    await expect(getTodaySnapshot()).resolves.toEqual({ kind: "needs-timezone" });
    expect(findCurrentDay).not.toHaveBeenCalled();
    expect(listTasksForDay).not.toHaveBeenCalled();
  });

  it("returns today's ready snapshot with the day's own timezone", async () => {
    const snapshot = await getTodaySnapshot();
    expect(snapshot).toMatchObject({
      kind: "ready",
      viewState: "today",
      dayId: "day-1",
      localDate: "2026-09-24",
      timezone: "Asia/Calcutta",
      tasks: [],
      spillover: [],
    });
    expect(findCurrentDay).toHaveBeenCalledTimes(1);
  });

  it("treats today's own date the same as no date", async () => {
    await expect(getTodaySnapshot("2026-09-24")).resolves.toMatchObject({ viewState: "today" });
  });

  it("loads yesterday's spillover for today, from the previous day's id and today's local start", async () => {
    vi.mocked(viewDay).mockResolvedValue(YESTERDAY);
    await getTodaySnapshot();
    expect(viewDay).toHaveBeenCalledWith(expect.anything(), "user-1", "2026-09-23");
    expect(listSpilloverTasks).toHaveBeenCalledWith(
      expect.anything(),
      "day-0",
      new Date("2026-09-23T18:30:00Z"),
    );
  });

  it("does not look for spillover when there is no previous day row", async () => {
    await getTodaySnapshot();
    expect(listSpilloverTasks).not.toHaveBeenCalled();
  });

  describe("the end-of-day review (Phase 7)", () => {
    const VIEW = { report: { id: "r1" }, isStale: true } as never;

    it("is loaded for today from today's own day id and the tasks just read", async () => {
      vi.mocked(loadEodReportView).mockResolvedValue(VIEW);
      const snapshot = await getTodaySnapshot();
      expect(snapshot).toMatchObject({ viewState: "today", eodReport: VIEW });
      expect(loadEodReportView).toHaveBeenCalledWith(expect.anything(), "day-1", []);
    });

    it("is null when no report exists yet", async () => {
      await expect(getTodaySnapshot()).resolves.toMatchObject({ eodReport: null });
    });

    it("is never loaded for a future day, even one that has a row — only today can be reviewed", async () => {
      vi.mocked(viewDay).mockImplementation(async (_c, _u, date) =>
        date === "2026-09-26"
          ? { id: "day-5", userId: "user-1", localDate: "2026-09-26", timezone: "Asia/Calcutta" }
          : null,
      );
      await expect(getTodaySnapshot("2026-09-26")).resolves.toMatchObject({ eodReport: null });
      expect(loadEodReportView).not.toHaveBeenCalled();
    });
  });

  describe("a future date", () => {
    it("with no day row is an empty read-only view: dayId null, nothing created, no task query", async () => {
      const snapshot = await getTodaySnapshot("2026-09-26");
      expect(snapshot).toMatchObject({
        kind: "ready",
        viewState: "future",
        dayId: null,
        localDate: "2026-09-26",
        timezone: "Asia/Calcutta", // the profile zone a new day would be created with
        tasks: [],
      });
      expect(findCurrentDay).not.toHaveBeenCalled(); // viewing must never create a day
      expect(listTasksForDay).not.toHaveBeenCalled();
    });

    it("with a row uses THAT day's frozen timezone and only its own tasks for the task list", async () => {
      const friday = {
        id: "day-5",
        userId: "user-1",
        localDate: "2026-09-26",
        timezone: "Pacific/Auckland",
      };
      vi.mocked(viewDay).mockImplementation(async (_c, _u, date) =>
        date === "2026-09-26" ? friday : null,
      );
      const snapshot = await getTodaySnapshot("2026-09-26");
      expect(snapshot).toMatchObject({
        viewState: "future",
        dayId: "day-5",
        timezone: "Pacific/Auckland",
      });
      expect(listTasksForDay).toHaveBeenCalledWith(expect.anything(), "day-5");
      expect(getLatestBriefing).not.toHaveBeenCalled(); // briefings belong to today
    });
  });

  describe("invalid dates go back to today", () => {
    it.each([
      ["yesterday", "2026-09-23"],
      ["today + 366", "2027-09-25"],
      ["garbage", "not-a-date"],
      ["an impossible date", "2026-02-30"],
      ["a timestamp", "2026-09-25T00:00:00Z"],
    ])("%s", async (_label, date) => {
      await expect(getTodaySnapshot(date)).resolves.toEqual({ kind: "invalid-date" });
      expect(findCurrentDay).not.toHaveBeenCalled();
      expect(listTasksForDay).not.toHaveBeenCalled();
    });

    it("accepts today + 365, the last plannable date", async () => {
      await expect(getTodaySnapshot("2027-09-24")).resolves.toMatchObject({ viewState: "future" });
    });
  });
});
