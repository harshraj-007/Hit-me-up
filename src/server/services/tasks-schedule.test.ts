import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ requireUserForAction: vi.fn() }));
vi.mock("@/server/db/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({})),
}));
vi.mock("@/server/db/repositories/tasks", () => ({
  getTaskById: vi.fn(),
  changeTaskStatus: vi.fn(),
  createTask: vi.fn(),
  listTasksForDay: vi.fn(),
  listSpilloverTasks: vi.fn(),
  rescheduleTask: vi.fn(),
  applyReplan: vi.fn(),
}));
vi.mock("@/server/db/repositories/days", () => ({ findDayById: vi.fn() }));
vi.mock("./day", () => ({
  resolveCurrentDay: vi.fn(),
  resolveDayForDate: vi.fn(),
  todayLocalDate: vi.fn(),
  viewDay: vi.fn(),
}));

import { requireUserForAction } from "@/server/auth/session";
import {
  applyReplan,
  getTaskById,
  listSpilloverTasks,
  listTasksForDay,
  rescheduleTask,
} from "@/server/db/repositories/tasks";
import { findDayById } from "@/server/db/repositories/days";
import { AuthenticationError, NotFoundError, ValidationError } from "@/server/errors";
import type { Task } from "@/domain/tasks";
import type { ScheduleChange } from "@/domain/scheduling";
import { resolveCurrentDay, todayLocalDate, viewDay } from "./day";
import { replanDay, rescheduleTaskForUser } from "./tasks";

const DAY = { id: "day-1", userId: "user-1", localDate: "2026-09-22", timezone: "UTC" };
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-22T10:00:00Z");
const t = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 22, h, m));

let seq = 0;
function makeTask(o: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: TASK_ID,
    userId: "user-1",
    dayId: "day-1",
    title: `Task ${seq}`,
    notes: null,
    status: "upcoming",
    priority: "medium",
    kind: "flexible",
    source: "user",
    scheduledStart: t(12),
    scheduledEnd: t(13),
    dueAt: null,
    completedAt: null,
    scheduleLocked: false,
    unscheduled: false,
    createdAt: new Date(Date.UTC(2026, 8, 22, 6, 0, seq)),
    updatedAt: t(6),
    ...o,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(requireUserForAction).mockResolvedValue({ id: "user-1", email: "a@b.com" });
  vi.mocked(resolveCurrentDay).mockResolvedValue(DAY);
  vi.mocked(findDayById).mockResolvedValue(DAY);
  vi.mocked(todayLocalDate).mockResolvedValue({ todayLocal: "2026-09-22", profileTimezone: "UTC" });
  vi.mocked(viewDay).mockResolvedValue(null);
  vi.mocked(listSpilloverTasks).mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

const MIN = 60_000;
/** Reschedule input: the task and the NEW START only — the end is never sent. */
const move = (start: Date, extra: Record<string, unknown> = {}) => ({
  taskId: TASK_ID,
  scheduledStart: start,
  ...extra,
});
/** A stored task of `minutes` minutes starting at 12:00 on the mocked day. */
const stored = (minutes: number, o: Partial<Task> = {}) =>
  makeTask({
    scheduledStart: t(12),
    scheduledEnd: new Date(t(12).getTime() + minutes * MIN),
    ...o,
  });
const endSent = () => vi.mocked(rescheduleTask).mock.calls.at(-1)![3] as Date;

describe("rescheduleTaskForUser", () => {
  it("requires a session before touching anything", async () => {
    vi.mocked(requireUserForAction).mockRejectedValueOnce(new AuthenticationError());
    await expect(rescheduleTaskForUser(move(t(14)))).rejects.toBeInstanceOf(AuthenticationError);
    expect(getTaskById).not.toHaveBeenCalled();
    expect(rescheduleTask).not.toHaveBeenCalled();
  });

  describe("keeps the task's duration: the server derives the end from the stored task", () => {
    it.each([30, 60, 90, 120])(
      "a %i-minute task: a same-day move sends start + %i minutes",
      async (minutes) => {
        vi.mocked(getTaskById).mockResolvedValue(stored(minutes));
        vi.mocked(rescheduleTask).mockResolvedValue(makeTask());
        await rescheduleTaskForUser(move(t(15)));
        expect(rescheduleTask).toHaveBeenCalledWith(
          expect.anything(),
          TASK_ID,
          t(15),
          new Date(t(15).getTime() + minutes * MIN),
        );
      },
    );

    it("90 minutes moved to 23:30 becomes 23:30 → 01:00 next day, on the same task and day", async () => {
      vi.mocked(getTaskById).mockResolvedValue(stored(90));
      vi.mocked(rescheduleTask).mockResolvedValue(makeTask());
      await rescheduleTaskForUser(move(t(23, 30)));
      expect(rescheduleTask).toHaveBeenCalledWith(expect.anything(), TASK_ID, t(23, 30), t(25));
    });

    it("120 minutes moved to 22:30 becomes 22:30 → 00:30 next day", async () => {
      vi.mocked(getTaskById).mockResolvedValue(stored(120));
      vi.mocked(rescheduleTask).mockResolvedValue(makeTask());
      await rescheduleTaskForUser(move(t(22, 30)));
      expect(endSent()).toEqual(t(24, 30));
    });

    it("a task of exactly 24 hours moves as 24 hours", async () => {
      vi.mocked(getTaskById).mockResolvedValue(stored(24 * 60));
      vi.mocked(rescheduleTask).mockResolvedValue(makeTask());
      await rescheduleTaskForUser(move(t(23, 30)));
      expect(endSent()).toEqual(t(47, 30));
    });

    it("uses the duration stored NOW, so a stale screen cannot resize the task", async () => {
      // The browser may still show a 60-minute task, but the database says 90: 90 wins.
      vi.mocked(getTaskById).mockResolvedValue(stored(90));
      vi.mocked(rescheduleTask).mockResolvedValue(makeTask());
      await rescheduleTaskForUser(move(t(15)));
      expect(endSent()).toEqual(t(16, 30));
    });
  });

  describe("attempts to alter the duration are refused, not ignored", () => {
    it.each([
      ["an explicit end", { scheduledEnd: t(20) }],
      ["an end that would shorten it", { scheduledEnd: t(15, 10) }],
      ["an end that would lengthen it to 24h", { scheduledEnd: t(39) }],
      ["a duration field", { durationMinutes: 300 }],
      ["a null end", { scheduledEnd: null }],
    ])("%s", async (_label, extra) => {
      await expect(rescheduleTaskForUser(move(t(15), extra))).rejects.toThrow(/duration/i);
      expect(getTaskById).not.toHaveBeenCalled();
      expect(rescheduleTask).not.toHaveBeenCalled();
    });

    it("even an end that happens to match the stored duration is refused: the end is never accepted", async () => {
      vi.mocked(getTaskById).mockResolvedValue(stored(60));
      await expect(rescheduleTaskForUser(move(t(15), { scheduledEnd: t(16) }))).rejects.toThrow();
      expect(rescheduleTask).not.toHaveBeenCalled();
    });

    it("a client-supplied user or day id is refused too (no authority, and no silent acceptance)", async () => {
      await expect(
        rescheduleTaskForUser(move(t(15), { userId: "victim", dayId: "victim-day" })),
      ).rejects.toThrow();
      expect(getTaskById).not.toHaveBeenCalled();
    });
  });

  describe("input", () => {
    it.each([
      ["missing start", { taskId: TASK_ID }],
      ["invalid timestamp", { taskId: TASK_ID, scheduledStart: "not a date" }],
      ["non-uuid task id", { taskId: "1; drop table tasks", scheduledStart: t(14) }],
    ])("rejects malformed input (%s) before any database call", async (_label, input) => {
      await expect(rescheduleTaskForUser(input)).rejects.toThrow();
      expect(getTaskById).not.toHaveBeenCalled();
      expect(rescheduleTask).not.toHaveBeenCalled();
    });
  });

  describe("state", () => {
    it.each(["completed", "skipped"] as const)(
      "rejects a %s task without calling the database",
      async (status) => {
        vi.mocked(getTaskById).mockResolvedValue(stored(60, { status }));
        await expect(rescheduleTaskForUser(move(t(15)))).rejects.toBeInstanceOf(ValidationError);
        expect(rescheduleTask).not.toHaveBeenCalled();
      },
    );

    it("a LOCKED task (already moved by hand) can be moved again, and keeps its duration", async () => {
      vi.mocked(getTaskById).mockResolvedValue(stored(90, { scheduleLocked: true }));
      vi.mocked(rescheduleTask).mockResolvedValue(makeTask({ scheduleLocked: true }));
      await rescheduleTaskForUser(move(t(17)));
      expect(rescheduleTask).toHaveBeenCalledWith(expect.anything(), TASK_ID, t(17), t(18, 30));
    });

    it("lets an overdue task be moved (late is derived, not terminal)", async () => {
      vi.mocked(getTaskById).mockResolvedValue(
        stored(60, { scheduledStart: t(8), scheduledEnd: t(9) }),
      );
      vi.mocked(rescheduleTask).mockResolvedValue(makeTask());
      await rescheduleTaskForUser(move(t(14)));
      expect(endSent()).toEqual(t(15));
    });

    it("STALE mutation: a task completed in another tab is refused with a clear error", async () => {
      // The screen still shows it as upcoming; by the time the request arrives it is completed.
      vi.mocked(getTaskById).mockResolvedValue(stored(60, { status: "completed" }));
      const error = await rescheduleTaskForUser(move(t(15))).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues[0]?.message).toMatch(/completed/);
      expect(rescheduleTask).not.toHaveBeenCalled();
    });

    it("STALE mutation: a task the caller can no longer see is not found", async () => {
      vi.mocked(getTaskById).mockResolvedValue(null);
      await expect(rescheduleTaskForUser(move(t(15)))).rejects.toBeInstanceOf(NotFoundError);
    });

    it("STALE mutation: if the database rejects (e.g. the task changed under us) the failure surfaces, nothing is faked", async () => {
      vi.mocked(getTaskById).mockResolvedValue(stored(60));
      vi.mocked(rescheduleTask).mockRejectedValue(
        new NotFoundError({ message: "Task not found." }),
      );
      await expect(rescheduleTaskForUser(move(t(15)))).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("planning day and ownership", () => {
    it("treats a task the caller can't see (another user's, hidden by RLS) as not found", async () => {
      vi.mocked(getTaskById).mockResolvedValue(null);
      await expect(rescheduleTaskForUser(move(t(15)))).rejects.toBeInstanceOf(NotFoundError);
      expect(rescheduleTask).not.toHaveBeenCalled();
    });

    it("treats a task whose day the caller can't see as not found", async () => {
      vi.mocked(getTaskById).mockResolvedValue(stored(60, { dayId: "hidden-day" }));
      vi.mocked(findDayById).mockResolvedValue(null);
      await expect(rescheduleTaskForUser(move(t(15)))).rejects.toBeInstanceOf(NotFoundError);
      expect(rescheduleTask).not.toHaveBeenCalled();
    });

    it("rejects a START outside the task's planning day, and a move that would already be over", async () => {
      vi.mocked(getTaskById).mockResolvedValue(stored(60));
      for (const bad of [t(24), t(-1), t(7)]) {
        await expect(rescheduleTaskForUser(move(bad))).rejects.toBeInstanceOf(ValidationError);
      }
      expect(rescheduleTask).not.toHaveBeenCalled();
    });

    it("can reschedule a previous day's SPILLOVER task even though it isn't today's task", async () => {
      // Thursday's 90-minute task (23:30 → 01:00), still running at 00:30 Friday; "today" is Friday.
      vi.setSystemTime(new Date("2026-09-23T00:30:00Z"));
      const thursday = {
        id: "day-thu",
        userId: "user-1",
        localDate: "2026-09-22",
        timezone: "UTC",
      };
      vi.mocked(getTaskById).mockResolvedValue(
        makeTask({ dayId: "day-thu", scheduledStart: t(23, 30), scheduledEnd: t(25) }),
      );
      vi.mocked(findDayById).mockResolvedValue(thursday);
      vi.mocked(resolveCurrentDay).mockResolvedValue({
        ...thursday,
        id: "day-fri",
        localDate: "2026-09-23",
      });
      vi.mocked(rescheduleTask).mockResolvedValue(makeTask());

      await rescheduleTaskForUser(move(t(23, 45)));

      expect(rescheduleTask).toHaveBeenCalledWith(expect.anything(), TASK_ID, t(23, 45), t(25, 15)); // still 90 min
      expect(findDayById).toHaveBeenCalledWith(expect.anything(), "day-thu");
      expect(resolveCurrentDay).not.toHaveBeenCalled();
    });
  });
});

describe("replanDay", () => {
  const planner = (id: string, o: Partial<Task> = {}) =>
    makeTask({ id, source: "planner", scheduledStart: t(8), scheduledEnd: t(9), ...o });

  it("requires a session", async () => {
    vi.mocked(requireUserForAction).mockRejectedValueOnce(new AuthenticationError());
    await expect(replanDay()).rejects.toBeInstanceOf(AuthenticationError);
    expect(listTasksForDay).not.toHaveBeenCalled();
  });

  it("on a user-only day writes nothing and creates no revision (report-only)", async () => {
    const a = makeTask({ id: "a", scheduledStart: t(11), scheduledEnd: t(12) });
    const b = makeTask({ id: "b", scheduledStart: t(11, 30), scheduledEnd: t(12, 30) });
    vi.mocked(listTasksForDay).mockResolvedValue([a, b]);

    const outcome = await replanDay();

    expect(applyReplan).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ changedCount: 0, revisionNumber: null });
    expect(outcome.conflicts).toEqual([{ firstTaskId: "a", secondTaskId: "b" }]);
    expect(outcome.tasks).toEqual([a, b]);
  });

  it("persists moves for planner tasks through ONE atomic call and re-reads the day", async () => {
    const late = planner("p1");
    const user = makeTask({ id: "u1", scheduledStart: t(10), scheduledEnd: t(11) });
    vi.mocked(listTasksForDay).mockResolvedValueOnce([late, user]);
    const after = [{ ...late, scheduledStart: t(11), scheduledEnd: t(12) }, user];
    vi.mocked(listTasksForDay).mockResolvedValueOnce(after);
    vi.mocked(applyReplan).mockResolvedValue(2);

    const outcome = await replanDay();

    expect(applyReplan).toHaveBeenCalledTimes(1);
    const [, dayId, changes] = vi.mocked(applyReplan).mock.calls[0]!;
    expect(dayId).toBe("day-1");
    expect((changes as ScheduleChange[]).map((c) => c.taskId)).toEqual(["p1"]);
    expect(outcome).toMatchObject({ changedCount: 1, revisionNumber: 2 });
    expect(outcome.tasks).toBe(after);
  });

  it("repeated identical replans create exactly one revision", async () => {
    // A tiny in-memory "database" behind the mocked repository.
    let db: Task[] = [
      planner("p1"),
      planner("p2", { scheduledStart: t(8, 30), scheduledEnd: t(9, 30) }),
    ];
    let revisions = 0;
    vi.mocked(listTasksForDay).mockImplementation(async () => db);
    vi.mocked(applyReplan).mockImplementation(async (_c, _d, changes) => {
      if (changes.length === 0) return null;
      db = db.map((task) => {
        const c = changes.find((x) => x.taskId === task.id);
        return c
          ? {
              ...task,
              scheduledStart: c.newStart,
              scheduledEnd: c.newEnd,
              unscheduled: c.newUnscheduled,
            }
          : task;
      });
      revisions += 1;
      return revisions + 1;
    });

    const first = await replanDay();
    expect(first.revisionNumber).toBe(2);
    for (let i = 0; i < 3; i++) {
      const again = await replanDay();
      expect(again).toMatchObject({ changedCount: 0, revisionNumber: null });
    }
    expect(revisions).toBe(1);
    expect(applyReplan).toHaveBeenCalledTimes(1);
  });

  it("never sends changes for user, locked, resolved or current tasks", async () => {
    vi.mocked(listTasksForDay).mockResolvedValue([
      makeTask({ id: "user", scheduledStart: t(8), scheduledEnd: t(9) }),
      planner("locked", { scheduleLocked: true }),
      planner("done", { status: "completed", completedAt: t(8) }),
      planner("skip", { status: "skipped" }),
      planner("cur", { scheduledStart: t(9, 30), scheduledEnd: t(10, 30) }),
    ]);
    await replanDay();
    expect(applyReplan).not.toHaveBeenCalled();
  });

  it("surfaces a stale-write conflict from the database instead of pretending it worked", async () => {
    vi.mocked(listTasksForDay).mockResolvedValue([planner("p1")]);
    vi.mocked(applyReplan).mockRejectedValue(new ValidationError([], { message: "changed" }));
    await expect(replanDay()).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("replanDay — planning days and spillover", () => {
  const FRI_DAY = { id: "day-fri", userId: "user-1", localDate: "2026-09-23", timezone: "UTC" };
  const fri = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 23, h, m));
  const plannerFri = (id: string, o: Partial<Task> = {}) =>
    makeTask({
      id,
      dayId: "day-fri",
      source: "planner",
      scheduledStart: fri(15),
      scheduledEnd: fri(16),
      ...o,
    });

  it("a future day is replanned over its WHOLE local day and persisted", async () => {
    vi.mocked(viewDay).mockImplementation(async (_c, _u, date) =>
      date === "2026-09-23" ? FRI_DAY : date === "2026-09-22" ? DAY : null,
    );
    const p = plannerFri("p1");
    vi.mocked(listTasksForDay)
      .mockResolvedValueOnce([p])
      .mockResolvedValueOnce([{ ...p, scheduledStart: fri(0), scheduledEnd: fri(1) }]);
    vi.mocked(applyReplan).mockResolvedValue(2);

    const outcome = await replanDay({ planningDate: "2026-09-23" });

    const [, dayId, changes] = vi.mocked(applyReplan).mock.calls[0]!;
    expect(dayId).toBe("day-fri");
    expect(changes).toMatchObject([{ taskId: "p1", newStart: fri(0), newEnd: fri(1) }]);
    expect(outcome).toMatchObject({ changedCount: 1, revisionNumber: 2 });
    expect(resolveCurrentDay).not.toHaveBeenCalled(); // a future day never touches today's day
  });

  it("a future day with no row is a no-op that reads and writes nothing", async () => {
    vi.mocked(viewDay).mockResolvedValue(null);
    const outcome = await replanDay({ planningDate: "2026-09-25" });
    expect(outcome).toMatchObject({ tasks: [], changedCount: 0, revisionNumber: null });
    expect(listTasksForDay).not.toHaveBeenCalled();
    expect(applyReplan).not.toHaveBeenCalled();
  });

  it("previous-day spillover is an obstacle: it is never in the changes and the planner works around it", async () => {
    vi.mocked(viewDay).mockImplementation(async (_c, _u, date) =>
      date === "2026-09-23" ? FRI_DAY : date === "2026-09-22" ? DAY : null,
    );
    // Thursday planner task 23:30 → Friday 01:00 (planner-owned, unlocked: movable in Thursday's
    // OWN replan, but from Friday's it is only an obstacle).
    const spill = makeTask({
      id: "spill",
      dayId: "day-1",
      source: "planner",
      scheduledStart: t(23, 30),
      scheduledEnd: fri(1),
    });
    vi.mocked(listSpilloverTasks).mockResolvedValue([spill]);
    const p = plannerFri("p1", { scheduledStart: fri(0), scheduledEnd: fri(1) });
    vi.mocked(listTasksForDay).mockResolvedValueOnce([p]).mockResolvedValueOnce([p]);
    vi.mocked(applyReplan).mockResolvedValue(2);

    await replanDay({ planningDate: "2026-09-23" });

    const changes = vi.mocked(applyReplan).mock.calls[0]![2];
    expect(changes.map((c) => c.taskId)).toEqual(["p1"]); // the spillover task is NOT among them
    expect(changes[0]).toMatchObject({ newStart: fri(1), newEnd: fri(2) });
    expect(listSpilloverTasks).toHaveBeenCalledWith(expect.anything(), "day-1", fri(0));
  });

  it("a task belonging to another planning day is never sent for change", async () => {
    vi.mocked(listTasksForDay).mockResolvedValue([]);
    vi.mocked(viewDay).mockResolvedValue(DAY);
    vi.mocked(listSpilloverTasks).mockResolvedValue([
      makeTask({
        id: "yesterday",
        dayId: "day-prev",
        source: "planner",
        scheduledStart: t(-1),
        scheduledEnd: t(1),
      }),
    ]);
    await replanDay();
    expect(applyReplan).not.toHaveBeenCalled();
  });

  it("rejects a date outside the horizon without reading anything", async () => {
    await expect(replanDay({ planningDate: "2027-09-23" })).rejects.toBeInstanceOf(ValidationError); // today+366
    await expect(replanDay({ planningDate: "2026-09-21" })).rejects.toBeInstanceOf(ValidationError); // past
    await expect(replanDay({ planningDate: "soon" })).rejects.toThrow();
    expect(listTasksForDay).not.toHaveBeenCalled();
  });

  it("takes only a date: a client-supplied day id is ignored", async () => {
    vi.mocked(listTasksForDay).mockResolvedValue([]);
    await replanDay({ dayId: "victim-day" });
    expect(resolveCurrentDay).toHaveBeenCalled();
    expect(listTasksForDay).toHaveBeenCalledWith(expect.anything(), "day-1");
  });

  it("still requires a known timezone", async () => {
    vi.mocked(todayLocalDate).mockResolvedValue(null);
    await expect(replanDay()).rejects.toBeInstanceOf(ValidationError);
  });
});
