import { assignAliases, formatLocalWallTime } from "@/domain/ai-planning";
import { taskDurationMs } from "@/domain/scheduling";
import {
  calculateDayProgress,
  deriveTaskTemporalState,
  type Task,
  type TaskHistoryEntry,
} from "@/domain/tasks";
import type { EodFacts, EodOutcome, EodTaskFact, EodTotals } from "./types";

export interface ComputeEodFactsInput {
  planningDate: string;
  /** The planning day's own frozen timezone — every time in the facts is read in it. */
  timezone: string;
  now: Date;
  /** THIS day's own tasks. Yesterday's cross-midnight spillover is not part of this day's review:
   *  it belongs to yesterday's tasks and is counted (and reviewed) there. */
  tasks: readonly Task[];
  /** History rows for those tasks. Rows for any other task are ignored. */
  history: readonly TaskHistoryEntry[];
  /** The day's plan revisions (the first is the initial plan, not a change). */
  revisions: readonly { revisionNumber: number }[];
}

const MINUTE_MS = 60_000;
const minutes = (ms: number) => Math.round(ms / MINUTE_MS);

function outcomeFor(task: Task, now: Date): EodOutcome {
  if (task.status === "completed") {
    return task.completedAt !== null && task.completedAt > task.scheduledEnd
      ? "completed_late"
      : "completed_on_time";
  }
  if (task.status === "skipped") return "skipped";
  switch (deriveTaskTemporalState(task, now)) {
    case "late":
      return "slipped";
    case "current":
      return "in_progress";
    case "unscheduled":
      return "unscheduled";
    default:
      return "not_yet_due";
  }
}

/** Recorded moves of one task's window, oldest first. A history row only counts if both its old
 *  and new window are present and actually differ — a replan row that merely flipped the
 *  `unscheduled` flag moved nothing. */
function recordedMoves(taskId: string, history: readonly TaskHistoryEntry[]) {
  return history
    .filter(
      (h) =>
        h.taskId === taskId &&
        (h.event === "rescheduled" || h.event === "replanned") &&
        h.previousStart !== null &&
        h.previousEnd !== null &&
        h.newStart !== null &&
        h.newEnd !== null &&
        (h.previousStart.getTime() !== h.newStart.getTime() ||
          h.previousEnd.getTime() !== h.newEnd.getTime()),
    )
    .sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime());
}

/**
 * The deterministic half of the end-of-day review. A pure function of persisted state and the
 * clock: the same rows at the same instant always produce the same facts, and nothing here — or
 * anything a model later says — can change what a task's outcome, duration or timing was.
 */
export function computeEodFacts(input: ComputeEodFactsInput): EodFacts {
  const { planningDate, timezone, now, tasks, history, revisions } = input;
  const { ordered, taskIdToRef } = assignAliases(tasks);
  const local = (instant: Date) => formatLocalWallTime(instant, timezone);

  const facts: EodTaskFact[] = ordered.map((task) => {
    const outcome = outcomeFor(task, now);
    const moves = recordedMoves(task.id, history);
    const first = moves[0];

    let minutesLate: number | null = null;
    if (outcome === "completed_late" && task.completedAt) {
      minutesLate = minutes(task.completedAt.getTime() - task.scheduledEnd.getTime());
    } else if (outcome === "slipped") {
      minutesLate = minutes(now.getTime() - task.scheduledEnd.getTime());
    }

    return {
      ref: taskIdToRef.get(task.id)!,
      title: task.title,
      priority: task.priority,
      kind: task.kind,
      outcome,
      start: local(task.scheduledStart),
      end: local(task.scheduledEnd),
      durationMinutes: minutes(taskDurationMs(task)),
      completedAt: task.completedAt ? local(task.completedAt) : null,
      minutesLate,
      rescheduleCount: moves.length,
      netShiftMinutes:
        first && first.previousStart
          ? minutes(task.scheduledStart.getTime() - first.previousStart.getTime())
          : null,
    };
  });

  const count = (o: EodOutcome) => facts.filter((f) => f.outcome === o).length;
  const sum = (pick: (f: EodTaskFact) => boolean) =>
    facts.filter(pick).reduce((total, f) => total + f.durationMinutes, 0);
  const isUnresolved = (f: EodTaskFact) =>
    f.outcome === "slipped" ||
    f.outcome === "in_progress" ||
    f.outcome === "not_yet_due" ||
    f.outcome === "unscheduled";
  const isCompleted = (f: EodTaskFact) =>
    f.outcome === "completed_on_time" || f.outcome === "completed_late";
  const high = facts.filter((f) => f.priority === "high");

  const progress = calculateDayProgress(tasks);
  const totals: EodTotals = {
    total: facts.length,
    completed: progress.completed,
    completedOnTime: count("completed_on_time"),
    completedLate: count("completed_late"),
    skipped: progress.skipped,
    unresolved: facts.filter(isUnresolved).length,
    slipped: count("slipped"),
    inProgress: count("in_progress"),
    notYetDue: count("not_yet_due"),
    unscheduled: count("unscheduled"),
    completionRatio: progress.ratio,
    plannedMinutes: sum((f) => f.outcome !== "skipped"),
    completedMinutes: sum(isCompleted),
    skippedMinutes: sum((f) => f.outcome === "skipped"),
    unresolvedMinutes: sum(isUnresolved),
    highPriorityTotal: high.length,
    highPriorityCompleted: high.filter(isCompleted).length,
    rescheduledTasks: facts.filter((f) => f.rescheduleCount > 0).length,
    totalReschedules: facts.reduce((total, f) => total + f.rescheduleCount, 0),
    planRevisions: Math.max(0, revisions.length - 1),
  };

  return { planningDate, timezone, asOf: local(now), tasks: facts, totals };
}

/**
 * A canonical string of the PERSISTED state a report depends on — each task's status, window,
 * unscheduled flag and completion instant — and nothing that moves with the clock. Two reads of
 * an unchanged day give the same string no matter when they happen, so "has the day changed since
 * this report?" is a plain comparison rather than a stored flag (and never goes stale just
 * because time passed). Task ids appear here because it is only ever hashed, never displayed or
 * stored. Every change that can alter a report goes through an RPC that updates the task row, so
 * this covers history and plan-revision changes too without reading either.
 */
export function eodStateCanonical(tasks: readonly Task[]): string {
  return [...tasks]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) =>
      [
        t.id,
        t.status,
        t.scheduledStart.getTime(),
        t.scheduledEnd.getTime(),
        t.unscheduled ? 1 : 0,
        t.completedAt ? t.completedAt.getTime() : "",
      ].join("|"),
    )
    .join("\n");
}
