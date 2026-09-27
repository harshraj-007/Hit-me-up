import { taskDurationMs, detectScheduleConflicts } from "@/domain/scheduling";
import { deriveTaskTemporalState, type Task } from "@/domain/tasks";
import type { DayBounds } from "@/domain/days";
import { assignAliases } from "./aliases";
import { formatLocalWallTime } from "./local-time";
import { isAiMovable } from "./movability";
import {
  MAX_PROPOSED_CHANGES,
  type ContextTask,
  type PlanningContext,
  type PlanningRules,
  type PlanningState,
} from "./types";

export const PLANNING_RULES: PlanningRules = {
  durationsAreFixed: true,
  allowedChangeKinds: ["move", "unschedule"],
  maxChanges: MAX_PROPOSED_CHANGES,
  newStartFormat: "YYYY-MM-DDTHH:mm",
  startMustBeWithinPlanningDay: true,
  onlyMovableTasksMayChange: true,
};

export interface BuildPlanningContextInput {
  dayId: string;
  planningDate: string;
  /** The planning day's own frozen timezone. */
  timezone: string;
  now: Date;
  dayBounds: DayBounds;
  /** The plan revision the snapshot was read at (for a future stale-proposal guard). */
  baseRevision: number;
  /** The caller's own tasks for this day plus previous-day spillover, read under RLS. */
  tasks: readonly Task[];
}

/**
 * Turns server-side rows into (a) the model-facing `PlanningContext` and (b) the
 * server-side `PlanningState` the validator trusts. The context is an EXPLICIT ALLOW-LIST:
 * each field below is copied by name, so a column added to `Task` later cannot leak into a
 * prompt by accident. Left out on purpose: user id, real task ids, notes, due dates,
 * timestamps of creation/completion, history, briefings, and the alias map itself.
 */
export function buildPlanningContext(input: BuildPlanningContextInput): {
  context: PlanningContext;
  state: PlanningState;
} {
  const { dayId, planningDate, timezone, now, dayBounds, baseRevision, tasks } = input;
  const { ordered, refToTaskId, taskIdToRef } = assignAliases(tasks);
  const local = (instant: Date) => formatLocalWallTime(instant, timezone);

  const contextTasks: ContextTask[] = ordered.map((task) => ({
    ref: taskIdToRef.get(task.id)!,
    title: task.title,
    status: task.status,
    temporal: deriveTaskTemporalState(task, now),
    kind: task.kind,
    priority: task.priority,
    start: local(task.scheduledStart),
    end: local(task.scheduledEnd),
    durationMinutes: Math.round(taskDurationMs(task) / 60_000),
    locked: task.scheduleLocked,
    fromPreviousDay: task.dayId !== dayId,
    movable: isAiMovable(task, now, dayId),
  }));

  const context: PlanningContext = {
    planningDate,
    timezone,
    now: local(now),
    dayBounds: { start: local(dayBounds.start), end: local(dayBounds.end) },
    baseRevision,
    tasks: contextTasks,
    conflicts: detectScheduleConflicts(tasks, now).map((c) => ({
      first: taskIdToRef.get(c.firstTaskId)!,
      second: taskIdToRef.get(c.secondTaskId)!,
    })),
    rules: PLANNING_RULES,
  };

  const state: PlanningState = {
    dayId,
    timezone,
    now,
    dayBounds,
    baseRevision,
    tasks: ordered,
    refToTaskId,
  };
  return { context, state };
}
