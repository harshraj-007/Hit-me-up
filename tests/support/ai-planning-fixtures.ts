import type { Task } from "@/domain/tasks";
import { dayBoundsUtc } from "@/domain/days";
import { buildPlanningContext } from "@/domain/ai-planning";

/** Planning day Thursday 2026-10-01 in UTC; "now" is that morning, so the whole evening is open. */
export const DAY_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_DAY_ID = "22222222-2222-4222-8222-222222222222";
export const USER_ID = "99999999-9999-4999-8999-999999999999";
export const TZ = "UTC";
export const PLANNING_DATE = "2026-10-01";
export const NOW = new Date("2026-10-01T09:00:00Z");
export const BOUNDS = dayBoundsUtc(PLANNING_DATE, TZ);

export const at = (h: number, m = 0, dayOffset = 0) =>
  new Date(Date.UTC(2026, 9, 1 + dayOffset, h, m));

let counter = 0;
/** A planner-created, unlocked, flexible, unresolved task — i.e. an AI-movable one. */
export function makeTask(overrides: Partial<Task> & { start: Date; end: Date }): Task {
  counter += 1;
  const { start, end, ...rest } = overrides;
  return {
    id: `aaaaaaaa-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    userId: USER_ID,
    dayId: DAY_ID,
    title: `Task ${counter}`,
    notes: "PRIVATE-NOTES-DO-NOT-LEAK",
    status: "upcoming",
    priority: "medium",
    kind: "flexible",
    source: "planner",
    scheduledStart: start,
    scheduledEnd: end,
    dueAt: null,
    completedAt: null,
    scheduleLocked: false,
    unscheduled: false,
    createdAt: new Date(Date.UTC(2026, 8, 30, 8, 0, counter)),
    updatedAt: new Date(Date.UTC(2026, 8, 30, 8, 0, counter)),
    ...rest,
  };
}

export function buildFor(tasks: Task[], now: Date = NOW, baseRevision = 3) {
  return buildPlanningContext({
    dayId: DAY_ID,
    planningDate: PLANNING_DATE,
    timezone: TZ,
    now,
    dayBounds: BOUNDS,
    baseRevision,
    tasks,
  });
}
