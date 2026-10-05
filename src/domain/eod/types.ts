/**
 * Provider-independent contracts for the end-of-day review (Phase 7).
 *
 * Trust model — three layers, deliberately separate:
 *
 *   EodFacts            DETERMINISTIC. Computed from the day's persisted tasks, task history and
 *                       plan revisions by `computeEodFacts`. Nothing a model says can enter or
 *                       change it: completion, durations, timestamps, priorities, titles and
 *                       reschedule counts all come from the database.
 *   EodInterpretation   UNTRUSTED model output, reduced to a closed shape: prose + task refs.
 *                       It may only INTERPRET the facts. `validateEodInterpretation` refuses
 *                       anything it cannot tie back to them.
 *   EodReport           The validated pair, as persisted. Facts are stored alongside the
 *                       interpretation so a report always shows exactly what was true when it
 *                       was written; whether the day has changed since is a live comparison.
 *
 * Nothing in this folder knows about a provider, Supabase, or the server runtime, and nothing
 * here writes anything. Task ids never appear in any of these types: tasks are named by an
 * alias (`t1`, `t2`, …) and by their own title.
 */
import type { TaskKind, TaskPriority } from "@/domain/tasks";

export const MAX_EOD_SUMMARY_LENGTH = 400;
export const MAX_EOD_TAKEAWAY_LENGTH = 200;
export const MAX_EOD_PATTERNS = 3;
export const MAX_EOD_PATTERN_LENGTH = 200;
export const MAX_EOD_PATTERN_REFS = 5;
export const MAX_EOD_CARRY_FORWARD = 5;
export const MAX_EOD_SUGGESTION_LENGTH = 160;
/** A day this large is not a day a one-screen review can say anything honest about. */
export const MAX_EOD_TASKS = 100;

/**
 * What happened to one task, as of the moment the report was computed. Exactly one applies.
 *
 *   completed_on_time  resolved `completed`, no later than its scheduled end
 *   completed_late     resolved `completed`, after its scheduled end
 *   skipped            resolved `skipped` — a decision, not a failure
 *   slipped            still unresolved and its scheduled end has passed
 *   in_progress        unresolved and inside its scheduled window right now
 *   not_yet_due        unresolved and its window has not started
 *   unscheduled        unresolved, and replanning could not fit it in the day
 */
export const EOD_OUTCOMES = [
  "completed_on_time",
  "completed_late",
  "skipped",
  "slipped",
  "in_progress",
  "not_yet_due",
  "unscheduled",
] as const;

export type EodOutcome = (typeof EOD_OUTCOMES)[number];

/** Outcomes that mean "still needs doing" — the only tasks that can be carried forward. */
export const UNRESOLVED_OUTCOMES: readonly EodOutcome[] = [
  "slipped",
  "in_progress",
  "not_yet_due",
  "unscheduled",
];

export interface EodTaskFact {
  /** Alias (`t1`, `t2`, …) — never a database id. */
  ref: string;
  /** The user's own title. Untrusted DATA wherever it is shown to a model. */
  title: string;
  priority: TaskPriority;
  kind: TaskKind;
  outcome: EodOutcome;
  /** Local wall-clock `YYYY-MM-DDTHH:mm` in the day's own (frozen) timezone. */
  start: string;
  end: string;
  durationMinutes: number;
  /** Local wall-clock, or null unless the task was completed. */
  completedAt: string | null;
  /** completed_late: minutes after the scheduled end it was completed. slipped: minutes since the
   *  scheduled end, as of `asOf`. Null otherwise. */
  minutesLate: number | null;
  /** How many times history recorded this task's window moving (a user reschedule or a replan). */
  rescheduleCount: number;
  /** Current start minus the ORIGINAL start (the earliest recorded previous start): positive means
   *  the task now sits later than first planned. Null if it was never moved. */
  netShiftMinutes: number | null;
}

export interface EodTotals {
  total: number;
  completed: number;
  completedOnTime: number;
  completedLate: number;
  skipped: number;
  /** slipped + inProgress + notYetDue + unscheduled. */
  unresolved: number;
  slipped: number;
  inProgress: number;
  notYetDue: number;
  unscheduled: number;
  /** completed / (total − skipped), or null when nothing is countable — the same definition the
   *  dashboard's own progress uses (`calculateDayProgress`). */
  completionRatio: number | null;
  plannedMinutes: number;
  completedMinutes: number;
  skippedMinutes: number;
  unresolvedMinutes: number;
  highPriorityTotal: number;
  highPriorityCompleted: number;
  /** Tasks whose window moved at least once / total recorded moves. */
  rescheduledTasks: number;
  totalReschedules: number;
  /** Plan revisions beyond the first — i.e. how many times the day's plan was changed. */
  planRevisions: number;
}

export interface EodFacts {
  planningDate: string;
  timezone: string;
  /** When the facts were computed, local wall-clock in `timezone`. */
  asOf: string;
  /** Alias order, i.e. `tasks[i].ref === "t" + (i + 1)`. */
  tasks: EodTaskFact[];
  totals: EodTotals;
}

// ── Model output (untrusted) ────────────────────────────────────────────────

export interface EodPattern {
  /** Plain prose. May name tasks only through `[t3]` placeholders, which are rendered to the
   *  task's own title server-side — a title is never written by the model. */
  text: string;
  refs: string[];
}

export interface EodCarryForward {
  ref: string;
  suggestion: string;
}

export interface EodInterpretation {
  /** What actually happened, in a sentence or two. */
  summary: string;
  patterns: EodPattern[];
  carryForward: EodCarryForward[];
  /** The single most useful thing to take from the day. */
  takeaway: string;
}

export interface EodReport {
  id: string;
  dayId: string;
  facts: EodFacts;
  interpretation: EodInterpretation;
  promptVersion: string;
  /** Opaque digest of the persisted task state the report was written against. */
  stateFingerprint: string;
  createdAt: Date;
}

export interface EodReportView {
  report: EodReport;
  /** The day's persisted task state differs from the one the report was written against. A live
   *  comparison, never itself stored. */
  isStale: boolean;
}
