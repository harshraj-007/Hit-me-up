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
import type { DayBounds } from "@/domain/days";
import type { Task, TaskKind, TaskPriority, TaskStatus, TemporalState } from "@/domain/tasks";

export const MAX_PROPOSED_CHANGES = 20;
export const MAX_USER_INTENT_LENGTH = 1000;
export const MAX_UNDERSTOOD_LENGTH = 500;
export const MAX_REASON_LENGTH = 300;
export const MAX_UNRESOLVED_ITEMS = 10;
export const MAX_UNRESOLVED_LENGTH = 300;

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

export type ProposedTaskChange = MoveChange | UnscheduleChange;

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
  | "unsupported_change";

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

export type ValidatedChange = ValidatedMove | ValidatedUnschedule;

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
