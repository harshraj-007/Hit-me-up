import { describe, expect, it } from "vitest";
import {
  isAutoMovable,
  replanRemainingDay,
  shouldCreatePlanRevision,
  type ReplanResult,
  type ReplanTask,
} from "./replan";

const t = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 22, h, m));
const dayBounds = { start: t(0), end: new Date(Date.UTC(2026, 8, 23)) };
const NOW = t(10);
const DAY = "day-thu";

let seq = 0;
function task(over: Partial<ReplanTask> & { minutes?: number; from?: Date }): ReplanTask {
  const { minutes = 60, from = t(12), ...rest } = over;
  seq += 1;
  return {
    id: `t${String(seq).padStart(3, "0")}`,
    dayId: DAY,
    status: "upcoming",
    source: "planner",
    kind: "flexible",
    priority: "medium",
    scheduledStart: from,
    scheduledEnd: new Date(from.getTime() + minutes * 60_000),
    dueAt: null,
    createdAt: new Date(Date.UTC(2026, 8, 22, 6, 0, seq)),
    scheduleLocked: false,
    unscheduled: false,
    ...rest,
  };
}

const replan = (tasks: ReplanTask[], now = NOW) =>
  replanRemainingDay({ dayId: DAY, now, tasks, dayBounds });
const change = (r: ReplanResult, id: string) => r.changes.find((c) => c.taskId === id);
const apply = (tasks: ReplanTask[], r: ReplanResult): ReplanTask[] =>
  tasks.map((x) => {
    const c = change(r, x.id);
    return c
      ? { ...x, scheduledStart: c.newStart, scheduledEnd: c.newEnd, unscheduled: c.newUnscheduled }
      : x;
  });

describe("replanRemainingDay — hard rules", () => {
  it("never moves completed or skipped tasks, even planner-created ones in the past", () => {
    const done = task({ status: "completed", from: t(8) });
    const skipped = task({ status: "skipped", from: t(9) });
    const r = replan([done, skipped]);
    expect(r.changes).toEqual([]);
    expect(r.unscheduled).toEqual([]);
  });

  it("never moves a user-created task, even an overdue one", () => {
    const overdue = task({ source: "user", from: t(8) });
    const future = task({ source: "user", from: t(14) });
    expect(replan([overdue, future]).changes).toEqual([]);
  });

  it("never moves a manually locked task", () => {
    expect(replan([task({ scheduleLocked: true, from: t(8) })]).changes).toEqual([]);
  });

  it("never moves a fixed task", () => {
    expect(replan([task({ kind: "fixed", from: t(8) })]).changes).toEqual([]);
  });

  it("never moves the task that is current right now", () => {
    const current = task({ from: t(9, 30), minutes: 60 }); // 09:30–10:30 contains NOW
    expect(replan([current]).changes).toEqual([]);
  });

  it("may move an overdue planner task, forward to now", () => {
    const late = task({ from: t(8), minutes: 30 });
    const r = replan([late]);
    expect(change(r, late.id)).toMatchObject({ newStart: t(10), newEnd: t(10, 30) });
  });

  it("never schedules anything before now (rounded up to the minute)", () => {
    const now = new Date(Date.UTC(2026, 8, 22, 10, 0, 20));
    const r = replan([task({ from: t(8), minutes: 30 })], now);
    expect(r.changes[0]!.newStart).toEqual(t(10, 1));
    expect(r.changes[0]!.newStart.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it("never deletes: every eligible task is either placed or reported unscheduled", () => {
    const tasks = [task({ minutes: 600 }), task({ minutes: 600 }), task({ minutes: 600 })];
    const r = replan(tasks);
    const accounted = new Set([
      ...r.changes.map((c) => c.taskId),
      ...r.unscheduled.map((u) => u.taskId),
    ]);
    for (const x of tasks) expect(accounted.has(x.id) || !isAutoMovable(x, NOW, DAY)).toBe(true);
  });

  it("preserves every task's duration exactly", () => {
    const tasks = [task({ minutes: 25 }), task({ minutes: 95 }), task({ minutes: 7 })];
    const r = replan(tasks);
    for (const c of r.changes) {
      const original = tasks.find((x) => x.id === c.taskId)!;
      expect(c.newEnd.getTime() - c.newStart.getTime()).toBe(
        original.scheduledEnd.getTime() - original.scheduledStart.getTime(),
      );
    }
  });
});

describe("replanRemainingDay — placement", () => {
  it("routes around user tasks and never overlaps them", () => {
    const user = task({ source: "user", from: t(10), minutes: 60 }); // 10:00–11:00
    const p = task({ from: t(10, 30), minutes: 30 });
    const r = replan([user, p]);
    expect(change(r, p.id)).toMatchObject({ newStart: t(11), newEnd: t(11, 30) });
  });

  it("fills an earlier gap rather than stacking after everything", () => {
    const user = task({ source: "user", from: t(10, 30), minutes: 60 }); // 10:30–11:30
    const p = task({ from: t(15), minutes: 30 });
    expect(change(replan([user, p]), p.id)).toMatchObject({ newStart: t(10), newEnd: t(10, 30) });
  });

  it("places by priority: high before medium before low, ahead of original order", () => {
    const low = task({ priority: "low", from: t(11), minutes: 60 });
    const high = task({ priority: "high", from: t(15), minutes: 60 });
    const med = task({ priority: "medium", from: t(12), minutes: 60 });
    const r = replan([low, med, high]);
    expect(change(r, high.id)!.newStart).toEqual(t(10));
    expect(change(r, med.id)!.newStart).toEqual(t(11));
    expect(change(r, low.id)!.newStart).toEqual(t(12));
  });

  it("gives an earlier due date precedence within a priority", () => {
    const later = task({ from: t(11), minutes: 60, dueAt: t(20) });
    const sooner = task({ from: t(12), minutes: 60, dueAt: t(12) });
    const r = replan([later, sooner]);
    expect(change(r, sooner.id)!.newStart).toEqual(t(10));
    // `later` already sits at 11:00, which is where the plan puts it: no change to report.
    expect(change(r, later.id)).toBeUndefined();
    expect(r.unscheduled).toEqual([]);
  });

  it("produces no overlap among the tasks it places, nor with obstacles", () => {
    const user = task({ source: "user", from: t(13), minutes: 90 });
    const tasks = [
      user,
      ...Array.from({ length: 6 }, (_, i) => task({ from: t(8), minutes: 30 + i * 5 })),
    ];
    const r = replan(tasks);
    const final = apply(tasks, r).filter((x) => x.status === "upcoming" && !x.unscheduled);
    const sorted = [...final].sort(
      (a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime(),
    );
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.scheduledStart.getTime()).toBeGreaterThanOrEqual(
        sorted[i - 1]!.scheduledEnd.getTime(),
      );
    }
    expect(r.conflicts).toEqual([]);
  });

  it("ignores completed and skipped tasks as obstacles (their time is free)", () => {
    const done = task({ status: "completed", from: t(11), minutes: 60 });
    const p = task({ from: t(15), minutes: 60 });
    expect(change(replan([done, p]), p.id)!.newStart).toEqual(t(10));
  });

  it("is limited to the local day: never extends past day end", () => {
    const now = t(23);
    const fits = task({ from: t(9), minutes: 60 });
    const r = replan([fits], now);
    expect(change(r, fits.id)).toMatchObject({
      newStart: t(23),
      newEnd: new Date(Date.UTC(2026, 8, 23)),
    });
  });

  it("uses the day's real start when now is somehow before it", () => {
    const early = new Date(Date.UTC(2026, 8, 21, 22, 0));
    const p = task({ from: t(9), minutes: 30 });
    expect(change(replan([p], early), p.id)!.newStart).toEqual(dayBounds.start);
  });
});

describe("replanRemainingDay — not enough room", () => {
  it("returns a task that cannot fit as unscheduled, unchanged in duration and not deleted", () => {
    const blocker = task({ source: "user", from: t(10), minutes: 13 * 60 }); // 10:00–23:00
    const p = task({ from: t(15), minutes: 120 });
    const r = replan([blocker, p]);
    expect(r.unscheduled).toEqual([{ taskId: p.id, reason: "no-room" }]);
    expect(change(r, p.id)).toMatchObject({
      newUnscheduled: true,
      newStart: p.scheduledStart, // times are kept, not truncated or cleared
      newEnd: p.scheduledEnd,
    });
  });

  it("does not truncate a task to squeeze it into a smaller gap", () => {
    const blocker = task({ source: "user", from: t(10, 30), minutes: 13 * 60 + 30 }); // to day end
    const p = task({ from: t(15), minutes: 60 }); // only 30 min free
    expect(replan([blocker, p]).unscheduled).toHaveLength(1);
  });

  it("lets a high-priority task claim scarce time; the lower one is the one left out", () => {
    const blocker = task({ source: "user", from: t(11), minutes: 12 * 60 + 1 }); // leaves 10:00–11:00 only
    const low = task({ priority: "low", from: t(12), minutes: 60 });
    const high = task({ priority: "high", from: t(13), minutes: 60 });
    const r = replan([blocker, low, high]);
    expect(change(r, high.id)).toMatchObject({ newUnscheduled: false, newStart: t(10) });
    expect(r.unscheduled).toEqual([{ taskId: low.id, reason: "no-room" }]);
  });

  it("reports past-due-date when the earliest slot misses due_at", () => {
    const p = task({ from: t(15), minutes: 60, dueAt: t(10, 30) });
    expect(replan([p]).unscheduled).toEqual([{ taskId: p.id, reason: "past-due-date" }]);
  });

  it("reports day-over once the day has ended", () => {
    const p = task({ from: t(15), minutes: 60 });
    expect(replan([p], new Date(Date.UTC(2026, 8, 23, 0, 0))).unscheduled).toEqual([
      { taskId: p.id, reason: "day-over" },
    ]);
  });

  it("gives a previously unscheduled task a slot when room appears", () => {
    const p = task({ unscheduled: true, from: t(15), minutes: 60 });
    const r = replan([p]);
    expect(change(r, p.id)).toMatchObject({
      previousUnscheduled: true,
      newUnscheduled: false,
      newStart: t(10),
    });
  });

  it("does not report a change for a task that is still unscheduled", () => {
    const blocker = task({ source: "user", from: t(10), minutes: 14 * 60 });
    const p = task({ unscheduled: true, from: t(15), minutes: 60 });
    const r = replan([blocker, p]);
    expect(r.changes).toEqual([]);
    expect(r.unscheduled).toEqual([{ taskId: p.id, reason: "no-room" }]);
  });

  it("an unscheduled task holds no slot for others", () => {
    const ghost = task({ unscheduled: true, source: "user", from: t(10), minutes: 60 });
    const p = task({ from: t(15), minutes: 30 });
    expect(change(replan([ghost, p]), p.id)!.newStart).toEqual(t(10));
  });
});

describe("replanRemainingDay — conflicts among tasks it must not move", () => {
  it("reports overlapping user tasks and leaves them alone", () => {
    const a = task({ source: "user", from: t(11), minutes: 60 });
    const b = task({ source: "user", from: t(11, 30), minutes: 60 });
    const r = replan([a, b]);
    expect(r.changes).toEqual([]);
    expect(r.conflicts).toEqual([{ firstTaskId: a.id, secondTaskId: b.id }]);
  });
});

describe("replanRemainingDay — determinism, idempotence, revisions", () => {
  const scenario = () => [
    task({ source: "user", from: t(11), minutes: 45 }),
    task({ priority: "high", from: t(9), minutes: 50 }),
    task({ priority: "low", from: t(9), minutes: 20 }),
    task({ from: t(16), minutes: 75, dueAt: t(22) }),
    task({ status: "completed", from: t(9) }),
  ];

  it("returns identical results for identical input, whatever the input order", () => {
    const tasks = scenario();
    const a = replan(tasks);
    const b = replan([...tasks].reverse());
    const norm = (r: ReplanResult) => ({
      ...r,
      changes: [...r.changes].sort((x, y) => x.taskId.localeCompare(y.taskId)),
    });
    expect(norm(a)).toEqual(norm(b));
    expect(replan(tasks)).toEqual(a);
  });

  it("creates a revision exactly when something changed", () => {
    const tasks = scenario();
    const first = replan(tasks);
    expect(first.changes.length).toBeGreaterThan(0);
    expect(shouldCreatePlanRevision(first)).toBe(true);
  });

  it("an already-replanned schedule replans to nothing: no repeated revisions", () => {
    let tasks = scenario();
    tasks = apply(tasks, replan(tasks));
    for (let i = 0; i < 3; i++) {
      const again = replan(tasks);
      expect(again.changes).toEqual([]);
      expect(shouldCreatePlanRevision(again)).toBe(false);
      tasks = apply(tasks, again);
    }
  });

  it("creates no revision on a day with nothing movable", () => {
    expect(shouldCreatePlanRevision(replan([task({ source: "user" })]))).toBe(false);
    expect(shouldCreatePlanRevision(replan([]))).toBe(false);
  });

  it("a manual move wins: locking a task removes it from later replans", () => {
    const p = task({ from: t(15), minutes: 60 });
    expect(replan([p]).changes).toHaveLength(1);
    expect(replan([{ ...p, scheduleLocked: true }]).changes).toEqual([]);
  });
});

describe("isAutoMovable", () => {
  it("requires unresolved, planner-sourced, unlocked, non-fixed and not current", () => {
    expect(isAutoMovable(task({ from: t(15) }), NOW, DAY)).toBe(true);
    expect(isAutoMovable(task({ source: "user", from: t(15) }), NOW, DAY)).toBe(false);
    expect(isAutoMovable(task({ status: "completed", from: t(15) }), NOW, DAY)).toBe(false);
    expect(isAutoMovable(task({ scheduleLocked: true, from: t(15) }), NOW, DAY)).toBe(false);
    expect(isAutoMovable(task({ kind: "fixed", from: t(15) }), NOW, DAY)).toBe(false);
    expect(isAutoMovable(task({ from: t(10), minutes: 30 }), NOW, DAY)).toBe(false); // current at start
    expect(isAutoMovable(task({ from: t(9, 30), minutes: 30 }), NOW, DAY)).toBe(true); // ended exactly now
  });
});

describe("replanRemainingDay — planning days and midnight", () => {
  const FRI = "day-fri";
  const friBounds = {
    start: new Date(Date.UTC(2026, 8, 23)),
    end: new Date(Date.UTC(2026, 8, 24)),
  };
  const fri = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 23, h, m));
  const replanFri = (tasks: ReplanTask[], now: Date) =>
    replanRemainingDay({ dayId: FRI, now, tasks, dayBounds: friBounds });

  it("a task of ANOTHER planning day is never moved, even if it is planner-owned and overdue", () => {
    const thursday = task({ dayId: "day-thu", from: t(8), minutes: 30 }); // planner, unlocked
    expect(isAutoMovable(thursday, NOW, FRI)).toBe(false);
    expect(replanFri([thursday], t(10)).changes).toEqual([]);
  });

  it("previous-day spillover is an obstacle: Friday's planner task is placed around it", () => {
    // Thursday 23:30 → Friday 01:00, user-owned, cross-midnight.
    const spill = task({ dayId: "day-thu", source: "user", from: t(23, 30), minutes: 90 });
    // A Friday planner task that wants 00:00.
    const p = task({ dayId: FRI, from: fri(0), minutes: 60 });
    const r = replanFri([spill, p], t(23, 45)); // before Friday starts, so p is not yet current
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ taskId: p.id, newStart: fri(1), newEnd: fri(2) });
    expect(r.changes.some((c) => c.taskId === spill.id)).toBe(false);
  });

  it("a PLANNER-owned Thursday spillover is also only an obstacle from Friday's replan", () => {
    const spill = task({ dayId: "day-thu", from: t(23, 30), minutes: 90 });
    const p = task({ dayId: FRI, from: fri(5), minutes: 30 });
    const r = replanFri([spill, p], fri(0));
    expect(r.changes.find((c) => c.taskId === spill.id)).toBeUndefined();
    expect(r.changes.find((c) => c.taskId === p.id)).toMatchObject({ newStart: fri(1) });
  });

  it("an in-progress cross-midnight task is preserved (current) and blocks the rest of its day", () => {
    // Thursday planner task 23:30 → Friday 01:00, replanned from Thursday at 23:45.
    const running = task({ from: t(23, 30), minutes: 90 });
    const p = task({ from: t(12), minutes: 10 });
    const r = replan([running, p], t(23, 45));
    expect(r.changes.find((c) => c.taskId === running.id)).toBeUndefined(); // never moved
    // Only 15 minutes of Thursday remain and the running task occupies all of them.
    expect(r.unscheduled).toEqual([{ taskId: p.id, reason: "no-room" }]);
  });

  it("a future day is replanned over its WHOLE local day, not from 'now'", () => {
    const p = task({ dayId: FRI, from: fri(15), minutes: 60 });
    const r = replanFri([p], t(10)); // now = Thursday 10:00, day starts Friday 00:00
    expect(r.changes[0]).toMatchObject({ newStart: fri(0), newEnd: fri(1) });
  });

  it("never creates a cross-midnight placement: the last hour is the latest a 2h task could end", () => {
    const blocker = task({ dayId: FRI, source: "user", from: fri(0), minutes: 23 * 60 + 30 });
    const p = task({ dayId: FRI, from: fri(12), minutes: 60 }); // only 30 min left
    const r = replanFri([blocker, p], fri(0));
    expect(r.unscheduled).toEqual([{ taskId: p.id, reason: "no-room" }]);
  });

  it("reports a cross-day overlap without resolving it", () => {
    const spill = task({ dayId: "day-thu", source: "user", from: t(23, 30), minutes: 90 });
    const own = task({ dayId: FRI, source: "user", from: fri(0, 30), minutes: 30 });
    const r = replanFri([spill, own], fri(0));
    expect(r.changes).toEqual([]);
    expect(r.conflicts).toEqual([{ firstTaskId: spill.id, secondTaskId: own.id }]);
  });

  it("stays idempotent with spillover and a future day in play", () => {
    const spill = task({ dayId: "day-thu", source: "user", from: t(23, 30), minutes: 90 });
    let tasks = [
      spill,
      task({ dayId: FRI, from: fri(9), minutes: 45 }),
      task({ dayId: FRI, priority: "high", from: fri(0), minutes: 75 }),
    ];
    tasks = apply(tasks, replanFri(tasks, t(10)));
    const again = replanFri(tasks, t(10));
    expect(again.changes).toEqual([]);
  });
});
