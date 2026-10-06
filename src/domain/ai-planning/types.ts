/**
 * Provider-independent contracts for AI-assisted replanning (Phase 5.0).
 *
 * Trust model — read this before touching anything here:
 *
 *   UserIntent.text     opaque user data (typed, or a voice transcript later)
 *   PlanProposal        UNTRUSTED model output; only its SHAPE has been checked (Zod)
 *   ValidationResult    the deterministic domain verdict — the only thing a future Apply may use
 *
 * Nothing in this file knows about an AI provider, Supabase, or the server runtime, and
 * nothing here mutates anything. The AI-facing types (PlanningContext, PlanProposal) are plain
 * JSON: no Dates, no UUIDs. `PlanningState` and `ValidationResult` are SERVER-SIDE ONLY — they
 * hold real task ids and must never be serialized into a prompt.
 */
import { MAX_TASK_DURATION_MS, type DayBounds } from "@/domain/days";
import type { Task, TaskKind, TaskPriority, TaskStatus, TemporalState } from "@/domain/tasks";

export const MAX_PROPOSED_CHANGES = 20;
export const MAX_USER_INTENT_LENGTH = 1000;
export const MAX_UNDERSTOOD_LENGTH = 500;
export const MAX_REASON_LENGTH = 300;
export const MAX_UNRESOLVED_ITEMS = 10;
export const MAX_UNRESOLVED_LENGTH = 300;

// ── New-task limits (Phase 8: plan from the briefing) ───────────────────────

/** Capped well under the database's 200-character column limit: a title is one short line. */
export const MAX_NEW_TASK_TITLE_LENGTH = 100;
export const MIN_NEW_TASK_MINUTES = 5;
/** The existing 24-hour task limit (`tasks_duration_max`) — a new task gets no larger one. */
export const MAX_NEW_TASK_MINUTES = MAX_TASK_DURATION_MS / 60_000;
/** The task kinds a proposal may create. `recurring` is deliberately not one of them. */
export const NEW_TASK_KINDS = ["flexible", "deadline", "optional", "fixed"] as const;
export type NewTaskKind = (typeof NEW_TASK_KINDS)[number];
export const NEW_TASK_PRIORITIES = ["high", "medium", "low"] as const;
export const MAX_BRIEFING_NOTE_LENGTH = MAX_USER_INTENT_LENGTH;

// ── User intent ─────────────────────────────────────────────────────────────

export type IntentSource = "typed" | "voice";

export interface UserIntent {
  /** Client-generated idempotency key. */
  id: string;
  source: IntentSource;
  /** Opaque user data: trimmed, ≤ 1000 chars, never interpreted by domain code. */
  text: string;
  /** The planning day, `YYYY-MM-DD`, already checked against the planning horizon. */
  planningDate: string;
  /** Stamped by the SERVER; never taken from the browser. */
  submittedAt: Date;
}

// ── AI-facing context (allow-listed, JSON-safe, alias-based) ────────────────

export interface PlanningRules {
  /** Every task keeps its duration; a move changes only the start. */
  durationsAreFixed: true;
  allowedChangeKinds: readonly ["move", "unschedule"];
  maxChanges: number;
  /** Format of `newStart`: local wall-clock time in the planning day's timezone. */
  newStartFormat: "YYYY-MM-DDTHH:mm";
  /** A task must START inside the planning day; its end may pass midnight. */
  startMustBeWithinPlanningDay: true;
  /** Only tasks with `movable: true` may be changed. */
  onlyMovableTasksMayChange: true;
}

/**
 * The rules a plan-from-briefing request states to the model (Phase 8). It is a statement of
 * what the validator enforces, never a grant: the model's output is judged by `validateProposal`
 * and, at confirmation, again in SQL.
 */
export interface BriefingPlanningRules {
  allowedChangeKinds: readonly ["create", "move", "unschedule"];
  maxChanges: number;
  /** Format of every `start` / `newStart`: local wall-clock time in the planning day's timezone. */
  startFormat: "YYYY-MM-DDTHH:mm";
  newTask: {
    titleMaxLength: number;
    durationMinutes: { min: number; max: number };
    priorities: readonly ["high", "medium", "low"];
    kinds: readonly ["flexible", "deadline", "optional", "fixed"];
    /** A new task starts no earlier than `now` and ends no later than the day's end. */
    mustFitInsideRemainingDay: true;
    /** A `fixed` task is only for a time the user themselves named in the briefing. */
    fixedRequiresTimeStatedInBriefing: true;
    /** Ends are derived (start + duration): the model never supplies one. */
    endIsDerived: true;
  };
  onlyMovableTasksMayChange: true;
}

export interface FreeWindow {
  /** Local wall-clock, `YYYY-MM-DDTHH:mm`. */
  start: string;
  end: string;
  minutes: number;
}

/**
 * Everything a plan-from-briefing request tells the model. The same allow-list discipline as
 * `PlanningContext` (aliases, no ids, no notes) plus the day's deterministic free windows and
 * the saved briefing — which is UNTRUSTED USER TEXT and the only free-form field here.
 */
export interface BriefingPlanningContext extends Omit<PlanningContext, "rules"> {
  rules: BriefingPlanningRules;
  /** Gaps in the remaining day, computed by the server. Advisory: the validator decides. */
  freeWindows: FreeWindow[];
  /** The user's own saved briefing, loaded by the server. Untrusted data, never instructions. */
  briefing: string;
}

export interface ContextTask {
  /** Alias (`t1`, `t2`, …) — never a database id. */
  ref: string;
  /** Untrusted user text. The prompt layer must delimit it and call it data. */
  title: string;
  status: TaskStatus;
  temporal: TemporalState;
  kind: TaskKind;
  priority: TaskPriority;
  /** Local wall-clock, `YYYY-MM-DDTHH:mm`, in `PlanningContext.timezone`. */
  start: string;
  end: string;
  durationMinutes: number;
  locked: boolean;
  fromPreviousDay: boolean;
  movable: boolean;
}

export interface PlanningContext {
  planningDate: string;
  timezone: string;
  /** Local wall-clock. */
  now: string;
  /** Local wall-clock; `end` is exclusive (the next local midnight). */
  dayBounds: { start: string; end: string };
  baseRevision: number;
  tasks: ContextTask[];
  /** Overlapping unresolved tasks right now, by alias. */
  conflicts: { first: string; second: string }[];
  rules: PlanningRules;
}

// ── Model output (untrusted) ────────────────────────────────────────────────

export interface MoveChange {
  kind: "move";
  ref: string;
  /** Local wall-clock start. There is deliberately NO end: it is derived from the stored duration. */
  newStart: string;
  reason: string;
}

export interface UnscheduleChange {
  kind: "unschedule";
  ref: string;
  reason: string;
}

/**
 * A NEW task (Phase 8). Everything the model may say about it is here — and nothing else: no
 * id, no end (derived from `start + durationMinutes`), no notes, no source, no due date.
 */
export interface CreateChange {
  kind: "create";
  title: string;
  /** Local wall-clock start in the planning day's timezone. */
  start: string;
  durationMinutes: number;
  priority: TaskPriority;
  taskKind: NewTaskKind;
  /** The model's claim that the USER named this time in the briefing. Required for `fixed`. */
  timeStated: boolean;
  reason: string;
}

export type ProposedTaskChange = MoveChange | UnscheduleChange | CreateChange;

export interface PlanProposal {
  /** Shown back to the user ("I understood…"). Untrusted display text. */
  understood: string;
  changes: ProposedTaskChange[];
  /** Requests the model could not turn into a supported change. */
  unresolved: string[];
}

// ── Server-side state and verdict ───────────────────────────────────────────

/**
 * Everything the validator trusts, built by the server from the database alongside the
 * context. `tasks` are real rows (real ids, notes, owner) and `refToTaskId` is the alias map:
 * NEITHER may ever be sent to a provider. The model's `PlanningContext` is not consulted
 * during validation — this snapshot is the single source of truth.
 */
export interface PlanningState {
  dayId: string;
  timezone: string;
  now: Date;
  dayBounds: DayBounds;
  baseRevision: number;
  tasks: readonly Task[];
  refToTaskId: ReadonlyMap<string, string>;
  /**
   * Present only for a plan-from-briefing request. Without it a `create` is refused outright —
   * the ordinary "Ask AI" flow cannot create tasks, whatever a model sends.
   */
  creation?: CreationPolicy;
}

export interface CreationPolicy {
  /** Whether the saved briefing itself contains a clock time (see `mentionsClockTime`). A
   *  `fixed` task needs one: the model's say-so alone never pins a task to a time. */
  briefingStatesClockTime: boolean;
}

export type RejectionCode =
  | "unknown_ref"
  | "resolved_task"
  | "locked_task"
  | "not_movable"
  | "invalid_time"
  | "outside_planning_day"
  | "in_the_past"
  | "window_invalid"
  | "duration_changed"
  | "no_change"
  | "duplicate_change"
  | "conflicting_changes"
  | "too_many_changes"
  | "unsupported_change"
  | "invalid_title"
  | "invalid_duration"
  | "invalid_priority"
  | "invalid_task_kind"
  | "fixed_missing_time"
  | "duplicate_title"
  | "overlaps_existing"
  | "overlaps_proposed";

export interface Rejection {
  code: RejectionCode;
  /** Fixed, safe English text (never model output, never a database error). */
  message: string;
  /** Position in the proposal's `changes`, or null for a whole-proposal rejection. */
  changeIndex: number | null;
  /** The alias, only when the model's ref was alias-shaped; otherwise null. */
  ref: string | null;
}

interface ValidatedChangeBase {
  changeIndex: number;
  ref: string;
  taskId: string;
  /** Always the task's own planning day: a move can never change it. */
  dayId: string;
  reason: string;
}

export interface ValidatedMove extends ValidatedChangeBase {
  kind: "move";
  previousStart: Date;
  previousEnd: Date;
  previousUnscheduled: boolean;
  newStart: Date;
  /** Derived: newStart + the task's existing duration. */
  newEnd: Date;
}

export interface ValidatedUnschedule extends ValidatedChangeBase {
  kind: "unschedule";
  previousStart: Date;
  previousEnd: Date;
}

/** A new task that passed every check. It has no task id yet: the database mints it. */
export interface ValidatedCreate {
  kind: "create";
  changeIndex: number;
  /** `n1`, `n2`, … assigned by the server in accepted order — never chosen by the model. */
  ref: string;
  title: string;
  start: Date;
  /** Derived: `start + durationMinutes`. */
  end: Date;
  durationMinutes: number;
  priority: TaskPriority;
  taskKind: NewTaskKind;
  reason: string;
}

export type ValidatedChange = ValidatedMove | ValidatedUnschedule | ValidatedCreate;

export interface ConflictAfter {
  firstTaskId: string;
  secondTaskId: string;
  firstRef: string | null;
  secondRef: string | null;
  /** True when at least one of the two tasks is changed by the accepted changes. */
  involvesProposal: boolean;
}

/**
 * `valid` means: at least one change, every change accepted, and NO conflicts remain.
 * `invalid` means nothing is applicable. Everything else is `partially_valid`. A future Apply
 * path must treat only `valid` as fully safe.
 */
export type ValidationStatus = "valid" | "partially_valid" | "invalid";

export interface ValidationResult {
  status: ValidationStatus;
  accepted: ValidatedChange[];
  rejected: Rejection[];
  conflictsAfter: ConflictAfter[];
  baseRevision: number;
}

/**
 * A proposal after transport parsing. Changes the parser could not accept were already turned
 * into `rejected`; `sourceIndexes[i]` is the position `proposal.changes[i]` had in what the
 * model actually sent, so rejections can always point at the right item.
 */
export interface ParsedProposal {
  proposal: PlanProposal;
  sourceIndexes: readonly number[];
  rejected: readonly Rejection[];
}
