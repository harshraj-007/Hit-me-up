import { UNRESOLVED_OUTCOMES, renderRefs, type EodOutcome, type EodReportView } from "@/domain/eod";

/**
 * A stored end-of-day report, shaped for display — pure, no React. Everything numeric comes from
 * the report's deterministic facts; everything the model wrote is only ever the prose, with
 * `[tN]` placeholders replaced by the user's own task titles. Kept separate from the panel for the
 * same reason `proposal-view.ts` is: the mapping is the part worth unit-testing, and the panel
 * stays a thin renderer.
 */
export interface EodStat {
  key: "done" | "skipped" | "open";
  label: string;
  value: number;
}

export interface EodCarryItem {
  key: string;
  title: string;
  /** Local time range of the task as planned, e.g. "5:00 – 6:00 PM". */
  when: string;
  /** Deterministic, from the task's outcome — never model text. */
  status: string;
  /** The model's suggestion for this task, if it gave one (validated, prose only). */
  suggestion: string | null;
}

export interface EodDisplay {
  takeaway: string;
  summary: string;
  stats: EodStat[];
  /** Deterministic one-liners about what moved or ran late; empty when nothing did. */
  notes: string[];
  patterns: string[];
  /** EVERY unresolved task, whatever the model chose to mention — a model that forgets a task
   *  cannot make it silently disappear from the carry-forward list. */
  carryForward: EodCarryItem[];
  reviewedAt: string;
  isStale: boolean;
}

const STATUS_LABEL: Record<EodOutcome, string> = {
  completed_on_time: "Done",
  completed_late: "Done late",
  skipped: "Skipped",
  slipped: "Past its time",
  in_progress: "In progress",
  not_yet_due: "Not started",
  unscheduled: "Didn't fit the day",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** `YYYY-MM-DDTHH:mm` (local wall-clock) → "9:14 PM". Pure string work: the value is already in the
 *  day's own timezone, so there is nothing to convert. */
export function formatLocalClock(local: string): string {
  const hours = Number(local.slice(11, 13));
  const minutes = local.slice(14, 16);
  const period = hours >= 12 ? "PM" : "AM";
  return `${hours % 12 === 0 ? 12 : hours % 12}:${minutes} ${period}`;
}

function formatLocalRange(start: string, end: string): string {
  const s = formatLocalClock(start);
  const e = formatLocalClock(end);
  const crossesMidnight = end.slice(0, 10) !== start.slice(0, 10);
  const sPeriod = s.slice(-2);
  const label =
    sPeriod === e.slice(-2) && !crossesMidnight ? `${s.slice(0, -3)} – ${e}` : `${s} – ${e}`;
  return crossesMidnight ? `${label} (next day)` : label;
}

export function buildEodDisplay(view: EodReportView): EodDisplay {
  const { facts, interpretation } = view.report;
  const { totals } = facts;
  const suggestions = new Map(interpretation.carryForward.map((c) => [c.ref, c.suggestion]));

  const notes: string[] = [];
  if (totals.completedLate > 0) {
    notes.push(`${plural(totals.completedLate, "task", "tasks")} finished late`);
  }
  if (totals.rescheduledTasks > 0) {
    notes.push(
      `${plural(totals.rescheduledTasks, "task", "tasks")} moved` +
        (totals.totalReschedules > totals.rescheduledTasks
          ? ` (${plural(totals.totalReschedules, "time", "times")} in all)`
          : ""),
    );
  }
  if (totals.planRevisions > 0) {
    notes.push(`The plan changed ${plural(totals.planRevisions, "time", "times")}`);
  }

  return {
    takeaway: renderRefs(interpretation.takeaway, facts.tasks),
    summary: renderRefs(interpretation.summary, facts.tasks),
    stats: [
      { key: "done", label: "done", value: totals.completed },
      { key: "skipped", label: "skipped", value: totals.skipped },
      { key: "open", label: "still open", value: totals.unresolved },
    ],
    notes,
    patterns: interpretation.patterns.map((p) => renderRefs(p.text, facts.tasks)),
    carryForward: facts.tasks
      .filter((t) => UNRESOLVED_OUTCOMES.includes(t.outcome))
      .map((t) => ({
        key: t.ref,
        title: t.title,
        when: formatLocalRange(t.start, t.end),
        status: STATUS_LABEL[t.outcome],
        suggestion: suggestions.get(t.ref) ?? null,
      })),
    reviewedAt: `Reviewed at ${formatLocalClock(facts.asOf)}`,
    isStale: view.isStale,
  };
}
