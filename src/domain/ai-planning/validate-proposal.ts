import { detectScheduleConflicts, taskDurationMs, validateReschedule } from "@/domain/scheduling";
import { deriveTaskTemporalState, isResolved, type Task } from "@/domain/tasks";
import { isAiMovable } from "./movability";
import { parseLocalWallTime } from "./local-time";
import {
  MAX_PROPOSED_CHANGES,
  type ConflictAfter,
  type ParsedProposal,
  type PlanProposal,
  type PlanningState,
  type ProposedTaskChange,
  type Rejection,
  type RejectionCode,
  type ValidatedChange,
  type ValidationResult,
} from "./types";

export interface ValidateProposalInput {
  /** The server's snapshot — the ONLY source of truth. The model's context is not consulted. */
  state: PlanningState;
  /**
   * UNTRUSTED model output after transport parsing. Taking the whole `ParsedProposal` (rather
   * than loose pieces) means the parser's rejections cannot be forgotten on the way in.
   */
  parsed: ParsedProposal;
}

/** Wraps an already well-formed proposal (no parser rejections, original positions). */
export function parsedFromProposal(proposal: PlanProposal): ParsedProposal {
  return { proposal, sourceIndexes: proposal.changes.map((_, i) => i), rejected: [] };
}

const MESSAGES = {
  unknown_ref: "That task isn't part of this plan.",
  resolved_task: "A completed or skipped task can't be changed.",
  locked_task: "You moved this task yourself, so it stays where you put it.",
  invalid_time: "That isn't a valid local date and time.",
  no_change: "That change wouldn't alter the schedule.",
  duplicate_change: "The same task was changed more than once.",
  conflicting_changes: "The same task was given contradictory changes.",
  too_many_changes: `A proposal can change at most ${MAX_PROPOSED_CHANGES} tasks.`,
} as const satisfies Partial<Record<RejectionCode, string>>;

function reject(
  code: RejectionCode,
  message: string,
  changeIndex: number | null,
  ref: string | null,
): Rejection {
  return { code, message, changeIndex, ref };
}

function notMovableMessage(task: Task, state: PlanningState): string {
  if (task.dayId !== state.dayId)
    return "This task belongs to another day, so it can't be moved here.";
  if (task.kind === "fixed") return "A fixed task can't be moved automatically.";
  if (deriveTaskTemporalState(task, state.now) === "current") {
    return "This task is in progress, so it can't be moved.";
  }
  return "This task can't be moved automatically.";
}

function classifyWindowFailure(
  task: Task,
  newStart: Date,
  state: PlanningState,
): "outside_planning_day" | "in_the_past" | "window_invalid" {
  const s = newStart.getTime();
  if (s < state.dayBounds.start.getTime() || s >= state.dayBounds.end.getTime()) {
    return "outside_planning_day";
  }
  if (s + taskDurationMs(task) <= state.now.getTime()) return "in_the_past";
  return "window_invalid";
}

/**
 * The deterministic verdict on an UNTRUSTED proposal. Pure. It decides, and the model does not:
 *
 *  - refs resolve only through the server's alias map (unknown / UUID / foreign → `unknown_ref`);
 *  - resolved, locked and non-movable tasks are never changed;
 *  - a move carries only a start: the end is the stored duration added to it, and the whole
 *    window is then judged by the existing `validateReschedule` (planning-day start, ≤ 24h,
 *    cross-midnight, "not already over"), against the task's OWN planning day;
 *  - a task named more than once is rejected in full — the validator never picks a winner;
 *  - remaining overlaps are found with the existing `detectScheduleConflicts` on the schedule
 *    the accepted changes would produce, and any of them keeps the result from being `valid`.
 */
export function validateProposal({ state, parsed }: ValidateProposalInput): ValidationResult {
  const { proposal, sourceIndexes } = parsed;
  const rejected: Rejection[] = [...parsed.rejected];

  if (proposal.changes.length > MAX_PROPOSED_CHANGES) {
    rejected.push(reject("too_many_changes", MESSAGES.too_many_changes, null, null));
    return finish(state, [], rejected);
  }

  const tasksById = new Map(state.tasks.map((t) => [t.id, t]));
  const indexOf = (i: number) => sourceIndexes[i] ?? i;

  // 1. Resolve refs through the server-held alias map only.
  const resolved: { index: number; change: ProposedTaskChange; task: Task }[] = [];
  proposal.changes.forEach((change, i) => {
    const index = indexOf(i);
    const taskId = state.refToTaskId.get(change.ref);
    const task = taskId === undefined ? undefined : tasksById.get(taskId);
    if (!task) {
      rejected.push(reject("unknown_ref", MESSAGES.unknown_ref, index, safeRef(change.ref)));
      return;
    }
    resolved.push({ index, change, task });
  });

  // 2. A task named more than once is refused entirely — same kind twice is a duplicate,
  //    different kinds are a contradiction. Never pick one.
  const byTask = new Map<string, typeof resolved>();
  for (const item of resolved)
    byTask.set(item.task.id, [...(byTask.get(item.task.id) ?? []), item]);

  const accepted: ValidatedChange[] = [];
  for (const items of byTask.values()) {
    if (items.length > 1) {
      const code =
        new Set(items.map((x) => x.change.kind)).size > 1
          ? "conflicting_changes"
          : "duplicate_change";
      for (const x of items)
        rejected.push(reject(code, MESSAGES[code], x.index, safeRef(x.change.ref)));
      continue;
    }
    const { index, change, task } = items[0]!;
    const outcome = validateOne(change, task, index, state);
    if ("code" in outcome) rejected.push(outcome);
    else accepted.push(outcome);
  }
  accepted.sort((a, b) => a.changeIndex - b.changeIndex);

  return finish(state, accepted, rejected);
}

function validateOne(
  change: ProposedTaskChange,
  task: Task,
  index: number,
  state: PlanningState,
): ValidatedChange | Rejection {
  const ref = change.ref;
  if (isResolved(task.status)) return reject("resolved_task", MESSAGES.resolved_task, index, ref);
  if (task.scheduleLocked) return reject("locked_task", MESSAGES.locked_task, index, ref);
  if (!isAiMovable(task, state.now, state.dayId)) {
    return reject("not_movable", notMovableMessage(task, state), index, ref);
  }

  const base = {
    changeIndex: index,
    ref,
    taskId: task.id,
    dayId: task.dayId,
    reason: change.reason,
  };

  if (change.kind === "unschedule") {
    if (task.unscheduled)
      return reject("no_change", "That task is already unscheduled.", index, ref);
    return {
      ...base,
      kind: "unschedule",
      previousStart: task.scheduledStart,
      previousEnd: task.scheduledEnd,
    };
  }

  const newStart = parseLocalWallTime(change.newStart, state.timezone);
  if (!newStart) return reject("invalid_time", MESSAGES.invalid_time, index, ref);
  if (!task.unscheduled && newStart.getTime() === task.scheduledStart.getTime()) {
    return reject("no_change", MESSAGES.no_change, index, ref);
  }

  // The existing authority. The end is derived inside it from the STORED duration.
  const check = validateReschedule(task, newStart, state.dayBounds, state.now);
  if (!check.ok) {
    return reject(classifyWindowFailure(task, newStart, state), check.reason, index, ref);
  }
  return {
    ...base,
    kind: "move",
    previousStart: task.scheduledStart,
    previousEnd: task.scheduledEnd,
    previousUnscheduled: task.unscheduled,
    newStart: check.start,
    newEnd: check.end,
  };
}

function safeRef(ref: string): string | null {
  return /^t[1-9]\d{0,3}$/.test(ref) ? ref : null;
}

function finish(
  state: PlanningState,
  accepted: ValidatedChange[],
  rejected: Rejection[],
): ValidationResult {
  const changed = new Map(accepted.map((c) => [c.taskId, c]));
  const after = state.tasks.map((task) => {
    const c = changed.get(task.id);
    if (!c) return task;
    return c.kind === "move"
      ? { ...task, scheduledStart: c.newStart, scheduledEnd: c.newEnd, unscheduled: false }
      : { ...task, unscheduled: true };
  });

  const refOf = new Map([...state.refToTaskId].map(([ref, id]) => [id, ref]));
  const conflictsAfter: ConflictAfter[] = detectScheduleConflicts(after, state.now).map((c) => ({
    firstTaskId: c.firstTaskId,
    secondTaskId: c.secondTaskId,
    firstRef: refOf.get(c.firstTaskId) ?? null,
    secondRef: refOf.get(c.secondTaskId) ?? null,
    involvesProposal: changed.has(c.firstTaskId) || changed.has(c.secondTaskId),
  }));

  rejected.sort((a, b) => (a.changeIndex ?? -1) - (b.changeIndex ?? -1));

  const status =
    accepted.length === 0
      ? "invalid"
      : rejected.length === 0 && conflictsAfter.length === 0
        ? "valid"
        : "partially_valid";

  return { status, accepted, rejected, conflictsAfter, baseRevision: state.baseRevision };
}
