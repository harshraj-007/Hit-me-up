import { detectScheduleConflicts, taskDurationMs, validateReschedule } from "@/domain/scheduling";
import { deriveTaskTemporalState, isResolved, type Task } from "@/domain/tasks";
import { isAiMovable } from "./movability";
import { parseLocalWallTime } from "./local-time";
import { checkNewTaskTitle, normalizeTitleKey } from "./new-task";
import {
  MAX_NEW_TASK_MINUTES,
  MAX_PROPOSED_CHANGES,
  MIN_NEW_TASK_MINUTES,
  NEW_TASK_KINDS,
  NEW_TASK_PRIORITIES,
  type ConflictAfter,
  type CreateChange,
  type MoveChange,
  type ParsedProposal,
  type PlanProposal,
  type PlanningState,
  type Rejection,
  type RejectionCode,
  type UnscheduleChange,
  type ValidatedChange,
  type ValidatedCreate,
  type ValidatedMove,
  type ValidatedUnschedule,
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
  outside_planning_day: "A new task has to start and finish inside the planning day.",
  in_the_past: "A new task can't start in the past.",
  invalid_title: "A new task needs a short plain-text title.",
  invalid_duration: `A new task must last between ${MIN_NEW_TASK_MINUTES} minutes and 24 hours.`,
  invalid_priority: "That isn't a valid priority.",
  invalid_task_kind: "That isn't a kind of task a plan can create.",
  fixed_missing_time:
    "A fixed task needs a time you gave yourself, and your briefing doesn't name one.",
  duplicate_title: "A task with that title already exists, or was proposed twice.",
  overlaps_existing: "That would overlap a task already on this day.",
  overlaps_proposed: "Two new tasks would overlap each other.",
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

  // 1. Resolve refs through the server-held alias map only. A `create` names no existing task,
  //    so it takes a separate path below.
  const resolved: { index: number; change: MoveChange | UnscheduleChange; task: Task }[] = [];
  const creates: { index: number; change: CreateChange }[] = [];
  proposal.changes.forEach((change, i) => {
    const index = indexOf(i);
    if (change.kind === "create") {
      creates.push({ index, change });
      return;
    }
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

  // 3. New tasks are judged against the schedule the accepted moves would produce.
  if (creates.length > 0) {
    const { created, refused } = validateCreates(creates, state, scheduleAfter(state, accepted));
    accepted.push(...created);
    rejected.push(...refused);
  }
  accepted.sort((a, b) => a.changeIndex - b.changeIndex);

  return finish(state, accepted, rejected);
}

function validateOne(
  change: MoveChange | UnscheduleChange,
  task: Task,
  index: number,
  state: PlanningState,
): ValidatedMove | ValidatedUnschedule | Rejection {
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
  const changed = new Map(
    accepted.flatMap((c) => (c.kind === "create" ? [] : [[c.taskId, c] as const])),
  );
  // New tasks are not in `after`: every accepted create was already checked, one by one, against
  // exactly this schedule and against each other, so none can add a conflict.
  const after = scheduleAfter(state, accepted);

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

/** The day's existing tasks as the accepted moves and unschedules would leave them. */
function scheduleAfter(state: PlanningState, accepted: readonly ValidatedChange[]): Task[] {
  const changed = new Map(
    accepted.flatMap((c) => (c.kind === "create" ? [] : [[c.taskId, c] as const])),
  );
  return state.tasks.map((task) => {
    const c = changed.get(task.id);
    if (!c) return task;
    return c.kind === "move"
      ? { ...task, scheduledStart: c.newStart, scheduledEnd: c.newEnd, unscheduled: false }
      : { ...task, unscheduled: true };
  });
}

interface Candidate {
  index: number;
  change: CreateChange;
  title: string;
  start: Date;
  end: Date;
}

/**
 * Judges every proposed NEW task. Nothing the model said about time is taken on trust: the
 * start is parsed through the day's own timezone, the end is `start + durationMinutes`, and the
 * whole window must sit inside the planning day, not already have begun, and clear every live
 * task (as the accepted moves leave them). Titles must be plain text and unique — against the
 * day's existing tasks and against each other. A refused create is simply not accepted, so the
 * result is never `valid`; the validator never trims, shifts or repairs a task to make it fit.
 *
 * Two creates that collide with EACH OTHER (same title, or overlapping windows) are both
 * refused — as with a task named twice, it never picks a winner.
 */
function validateCreates(
  creates: readonly { index: number; change: CreateChange }[],
  state: PlanningState,
  existing: readonly Task[],
): { created: ValidatedCreate[]; refused: Rejection[] } {
  const refused: Rejection[] = [];
  const fail = (code: keyof typeof MESSAGES, index: number) =>
    refused.push(reject(code, MESSAGES[code], index, null));

  if (!state.creation) {
    // The ordinary "Ask AI" flow never creates tasks, whatever a model sends: only a
    // plan-from-briefing request sets a creation policy.
    return {
      created: [],
      refused: creates.map(({ index }) =>
        reject("unsupported_change", "That kind of change isn't supported here.", index, null),
      ),
    };
  }

  const dayStart = state.dayBounds.start.getTime();
  const dayEnd = state.dayBounds.end.getTime();
  const now = state.now.getTime();
  const ownTitles = new Set(
    state.tasks.filter((t) => t.dayId === state.dayId).map((t) => normalizeTitleKey(t.title)),
  );
  const live = existing.filter(
    (t) => t.status === "upcoming" && !t.unscheduled && t.scheduledEnd.getTime() > now,
  );

  const candidates: Candidate[] = [];
  for (const { index, change } of creates) {
    const title = checkNewTaskTitle(change.title);
    if (!title.ok) {
      fail("invalid_title", index);
      continue;
    }
    const minutes = change.durationMinutes;
    if (
      !Number.isInteger(minutes) ||
      minutes < MIN_NEW_TASK_MINUTES ||
      minutes > MAX_NEW_TASK_MINUTES
    ) {
      fail("invalid_duration", index);
      continue;
    }
    if (!(NEW_TASK_PRIORITIES as readonly string[]).includes(change.priority)) {
      fail("invalid_priority", index);
      continue;
    }
    if (!(NEW_TASK_KINDS as readonly string[]).includes(change.taskKind)) {
      fail("invalid_task_kind", index);
      continue;
    }
    if (
      change.taskKind === "fixed" &&
      (change.timeStated !== true || !state.creation.briefingStatesClockTime)
    ) {
      fail("fixed_missing_time", index);
      continue;
    }
    const start = parseLocalWallTime(change.start, state.timezone);
    if (!start) {
      fail("invalid_time", index);
      continue;
    }
    const end = new Date(start.getTime() + minutes * 60_000);
    if (start.getTime() < dayStart || end.getTime() > dayEnd) {
      fail("outside_planning_day", index);
      continue;
    }
    if (start.getTime() < now) {
      fail("in_the_past", index);
      continue;
    }
    if (ownTitles.has(normalizeTitleKey(title.title))) {
      fail("duplicate_title", index);
      continue;
    }
    if (
      live.some(
        (t) =>
          t.scheduledStart.getTime() < end.getTime() && start.getTime() < t.scheduledEnd.getTime(),
      )
    ) {
      fail("overlaps_existing", index);
      continue;
    }
    candidates.push({ index, change, title: title.title, start, end });
  }

  // Against each other: first titles, then windows.
  const byTitle = new Map<string, Candidate[]>();
  for (const c of candidates)
    byTitle.set(normalizeTitleKey(c.title), [
      ...(byTitle.get(normalizeTitleKey(c.title)) ?? []),
      c,
    ]);
  const dupes = new Set<Candidate>();
  for (const group of byTitle.values()) if (group.length > 1) group.forEach((c) => dupes.add(c));
  dupes.forEach((c) => fail("duplicate_title", c.index));

  const survivors = candidates.filter((c) => !dupes.has(c));
  const colliding = new Set<Candidate>();
  for (let i = 0; i < survivors.length; i++) {
    for (let j = i + 1; j < survivors.length; j++) {
      const a = survivors[i]!;
      const b = survivors[j]!;
      if (a.start < b.end && b.start < a.end) {
        colliding.add(a);
        colliding.add(b);
      }
    }
  }
  colliding.forEach((c) => fail("overlaps_proposed", c.index));

  const created: ValidatedCreate[] = survivors
    .filter((c) => !colliding.has(c))
    .sort((a, b) => a.index - b.index)
    .map((c, i) => ({
      kind: "create" as const,
      changeIndex: c.index,
      ref: `n${i + 1}`,
      title: c.title,
      start: c.start,
      end: c.end,
      durationMinutes: c.change.durationMinutes,
      priority: c.change.priority,
      taskKind: c.change.taskKind,
      reason: c.change.reason,
    }));
  return { created, refused };
}
