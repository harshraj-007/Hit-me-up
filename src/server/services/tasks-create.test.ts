import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "../../../tests/support/fake-db";

const holder: { db: FakeDb } = { db: createFakeDb() };

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/session", () => ({
  requireUserForAction: vi.fn(async () => ({ id: "user-1", email: null })),
}));
vi.mock("@/server/db/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(async () => holder.db.client),
}));
vi.mock("@/server/db/repositories/tasks", () => ({
  createTask: vi.fn(async (_c: unknown, input: Record<string, unknown>) => ({
    ...input,
    id: "task-1",
  })),
  getTaskById: vi.fn(),
  changeTaskStatus: vi.fn(),
  listTasksForDay: vi.fn(),
  listSpilloverTasks: vi.fn(),
  rescheduleTask: vi.fn(),
  applyReplan: vi.fn(),
}));

import { wallTimeToUtc } from "@/domain/days";
import { createTask } from "@/server/db/repositories/tasks";
import { ValidationError } from "@/server/errors";
import { syncTimezone } from "./profile";
import { createTaskForDay } from "./tasks";

// 15:30 on Thu 2026-09-24 in Kolkata (10:00Z).
const NOW = new Date("2026-09-24T10:00:00Z");
const TZ = "Asia/Kolkata";
const at = (date: string, time: string) => wallTimeToUtc({ date, time, timezone: TZ });
const task = (date: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({
  title: "Plan",
  scheduledStart: at(date, from),
  scheduledEnd: at(date, to),
  ...extra,
});
const localDates = () => holder.db.tables.days.map((d) => d.local_date as string).sort();

beforeEach(async () => {
  holder.db = createFakeDb();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await syncTimezone(TZ);
});
afterEach(() => vi.useRealTimers());

describe("createTaskForDay — which planning day", () => {
  it("defaults to today, resolved server-side", async () => {
    await createTaskForDay(task("2026-09-24", "18:00", "19:30"));
    expect(localDates()).toEqual(["2026-09-24"]);
    expect(vi.mocked(createTask).mock.calls[0]![1]).toMatchObject({ dayId: "day-1" });
  });

  it("plans for TOMORROW: the day is created on demand and the task goes on it", async () => {
    await createTaskForDay(task("2026-09-25", "18:00", "19:30", { planningDate: "2026-09-25" }));
    expect(localDates()).toEqual(["2026-09-25"]); // no day for today was needed
    const day = holder.db.tables.days[0]!;
    expect(vi.mocked(createTask).mock.calls[0]![1]).toMatchObject({ dayId: day.id });
    expect(holder.db.tables.plans).toHaveLength(1);
    expect(holder.db.tables.plan_revisions).toHaveLength(1);
  });

  it("accepts today + 365 (the last plannable date) …", async () => {
    await createTaskForDay(task("2027-09-24", "10:00", "11:00", { planningDate: "2027-09-24" }));
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it("… and rejects today + 366, creating nothing", async () => {
    await expect(
      createTaskForDay(task("2027-09-25", "10:00", "11:00", { planningDate: "2027-09-25" })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(createTask).not.toHaveBeenCalled();
    expect(holder.db.tables.days).toHaveLength(0);
    // Rejected by the service BEFORE the database is asked (the SQL check is a second line).
    expect(holder.db.writes.filter((w) => w.op === "rpc")).toHaveLength(0);
  });

  it("rejects a past date (yesterday), creating nothing", async () => {
    await expect(
      createTaskForDay(task("2026-09-23", "10:00", "11:00", { planningDate: "2026-09-23" })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(createTask).not.toHaveBeenCalled();
    expect(holder.db.tables.days).toHaveLength(0);
    expect(holder.db.writes.filter((w) => w.op === "rpc")).toHaveLength(0);
  });

  it("ignores a client-supplied day id: the day is the one the server resolved", async () => {
    await createTaskForDay(task("2026-09-24", "18:00", "19:00", { dayId: "victim-day" }));
    expect(vi.mocked(createTask).mock.calls[0]![1]).toMatchObject({ dayId: "day-1" });
    expect(vi.mocked(createTask).mock.calls[0]![1]).not.toMatchObject({ dayId: "victim-day" });
  });
});

describe("createTaskForDay — the window (start inside the day, ≤ 24h, end may cross midnight)", () => {
  it("accepts Thu 23:30 → Fri 01:00 and keeps it on Thursday's day", async () => {
    await createTaskForDay({
      title: "Late",
      scheduledStart: at("2026-09-24", "23:30"),
      scheduledEnd: at("2026-09-25", "01:00"),
    });
    expect(localDates()).toEqual(["2026-09-24"]);
    expect(vi.mocked(createTask).mock.calls[0]![1]).toMatchObject({ dayId: "day-1" });
  });

  it("accepts exactly 24h from a start inside the day", async () => {
    await createTaskForDay({
      title: "Long",
      scheduledStart: at("2026-09-24", "23:30"),
      scheduledEnd: at("2026-09-25", "23:30"),
    });
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it("rejects more than 24h", async () => {
    await expect(
      createTaskForDay({
        title: "Too long",
        scheduledStart: at("2026-09-24", "23:30"),
        scheduledEnd: at("2026-09-26", "00:00"),
      }),
    ).rejects.toThrow();
    expect(createTask).not.toHaveBeenCalled();
  });

  it("closes the old unbounded-offset hole: a task starting on ANOTHER date can't be filed under today", async () => {
    // What "starts in 1500 minutes" used to do: tomorrow's time, today's day.
    await expect(createTaskForDay(task("2026-09-25", "10:00", "11:00"))).rejects.toBeInstanceOf(
      ValidationError,
    );
    // …and a start before the day began.
    await expect(
      createTaskForDay({
        title: "Early",
        scheduledStart: at("2026-09-23", "23:00"),
        scheduledEnd: at("2026-09-24", "01:00"),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("a future day's window is judged against THAT day, in the day's own timezone", async () => {
    // 2026-09-25 00:00 IST = 2026-09-24T18:30Z: valid for the 25th, invalid for a task on the 24th.
    const start = at("2026-09-25", "00:00");
    await createTaskForDay({
      title: "Midnight",
      scheduledStart: start,
      scheduledEnd: at("2026-09-25", "01:00"),
      planningDate: "2026-09-25",
    });
    await expect(
      createTaskForDay({
        title: "Wrong day",
        scheduledStart: start,
        scheduledEnd: at("2026-09-25", "01:00"),
        planningDate: "2026-09-24",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("createTaskForDay — frozen timezone", () => {
  it("uses the day's ORIGINAL timezone after the profile timezone changes", async () => {
    await createTaskForDay(task("2026-09-24", "18:00", "19:00")); // day created in Kolkata
    await syncTimezone("America/Los_Angeles");
    // Same instant range, still accepted because the day's frozen bounds are Kolkata's.
    await createTaskForDay({
      title: "Again",
      scheduledStart: at("2026-09-24", "20:00"),
      scheduledEnd: at("2026-09-24", "21:00"),
    });
    // Still 24 Sep in Los Angeles at this instant, so the SAME day row is reused — and it was not
    // re-stamped with the new profile timezone.
    expect(holder.db.tables.days.map((d) => d.timezone)).toEqual([TZ]);
  });
});
