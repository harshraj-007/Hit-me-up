/**
 * ──────────────────────────────────────────────────────────────────────────
 * MOCK DATA — not persisted, not real AI output, not wired to Supabase.
 * Everything in this file exists only to make the Phase 2 visual shell
 * demonstrable. It must not be imported by anything under `domain/` or
 * `server/`, and it gets deleted the moment Phase 3+ wires up real data.
 * ──────────────────────────────────────────────────────────────────────────
 */
import { addMinutes } from "date-fns";
import type { DashboardTask, DaySummary } from "@/features/dashboard/types";

interface Draft {
  id: string;
  title: string;
  /** Minutes relative to "now", so the mock day always looks current whenever it's viewed. */
  startOffset: number;
  durationMinutes: number;
  status: DashboardTask["status"];
  priority: DashboardTask["priority"];
  kind: DashboardTask["kind"];
  dueOffset?: number;
  note?: string;
}

const BASE_DAY: Draft[] = [
  {
    id: "morning-pages",
    title: "Morning pages",
    startOffset: -195,
    durationMinutes: 30,
    status: "completed",
    priority: "low",
    kind: "flexible",
  },
  {
    id: "morning-run",
    title: "Morning run",
    startOffset: -160,
    durationMinutes: 60,
    status: "skipped",
    priority: "medium",
    kind: "flexible",
    note: "Skipped — moved to tomorrow.",
  },
  {
    id: "problem-set-4",
    title: "Finish Problem Set 4 (Calc II)",
    startOffset: -95,
    durationMinutes: 35,
    status: "completed",
    priority: "high",
    kind: "deadline",
    dueOffset: -60,
  },
  {
    id: "chem-lab-prep",
    title: "Chem lab prep questions",
    startOffset: -55,
    durationMinutes: 40,
    status: "late",
    priority: "high",
    kind: "deadline",
    dueOffset: 120,
    note: "Missed this block — still due today.",
  },
  {
    id: "study-group",
    title: "Study group call — Econ 301",
    startOffset: -10,
    durationMinutes: 45,
    status: "current",
    priority: "medium",
    kind: "fixed",
  },
  {
    id: "grocery-run",
    title: "Grocery pickup",
    startOffset: 45,
    durationMinutes: 30,
    status: "upcoming",
    priority: "low",
    kind: "optional",
  },
  {
    id: "essay-draft",
    title: "Draft comparative politics essay",
    startOffset: 90,
    durationMinutes: 90,
    status: "upcoming",
    priority: "high",
    kind: "flexible",
  },
  {
    id: "dinner",
    title: "Dinner with roommates",
    startOffset: 200,
    durationMinutes: 60,
    status: "upcoming",
    priority: "medium",
    kind: "fixed",
  },
  {
    id: "flashcards",
    title: "Review Spanish vocab",
    startOffset: 280,
    durationMinutes: 30,
    status: "upcoming",
    priority: "low",
    kind: "recurring",
  },
];

function draftToTask(d: Draft, now: Date): DashboardTask {
  const start = addMinutes(now, d.startOffset);
  return {
    id: d.id,
    title: d.title,
    start,
    end: addMinutes(start, d.durationMinutes),
    status: d.status,
    priority: d.priority,
    kind: d.kind,
    dueAt: d.dueOffset === undefined ? undefined : addMinutes(now, d.dueOffset),
    note: d.note,
  };
}

function byStart(a: DashboardTask, b: DashboardTask): number {
  return a.start.getTime() - b.start.getTime();
}

export function buildMockDay(now: Date): DashboardTask[] {
  return BASE_DAY.map((d) => draftToTask(d, now)).sort(byStart);
}

/** Reshuffles only the tasks the user hasn't already acted on, relative to the given `now`. */
const REPLAN_PATCH: Partial<Record<string, Partial<Draft>>> = {
  "grocery-run": { status: "skipped", note: "Skipped — pushed to tomorrow by replan." },
  "essay-draft": { startOffset: 20, durationMinutes: 75 },
};

const REPLAN_INSERT: Draft = {
  id: "advisor-call",
  title: "Quick call with academic advisor",
  startOffset: 65,
  durationMinutes: 20,
  status: "upcoming",
  priority: "medium",
  kind: "fixed",
};

const RESOLVED_STATUSES = new Set<DashboardTask["status"]>(["completed", "skipped", "late"]);

/**
 * Stands in for a real replanning call: it never touches a task the user already resolved
 * (completed/skipped/marked late) or removes a task they added — mirroring the real rule in
 * PROJECT_ARCHITECTURE.md §2 ("replanning never moves completed work or drops history"),
 * even though this version just applies a fixed, fake patch instead of calling Claude.
 */
export function applyMockReplan(tasks: DashboardTask[], now: Date): DashboardTask[] {
  const patched = tasks.map((task) => {
    const patch = REPLAN_PATCH[task.id];
    if (!patch || RESOLVED_STATUSES.has(task.status)) return task;
    const start = patch.startOffset === undefined ? task.start : addMinutes(now, patch.startOffset);
    const durationMinutes =
      patch.durationMinutes ?? (task.end.getTime() - task.start.getTime()) / 60_000;
    return {
      ...task,
      start,
      end: addMinutes(start, durationMinutes),
      status: patch.status ?? task.status,
      note: patch.note ?? task.note,
    };
  });

  const hasInsert = patched.some((t) => t.id === REPLAN_INSERT.id);
  const withInsert = hasInsert ? patched : [...patched, draftToTask(REPLAN_INSERT, now)];

  return withInsert.sort(byStart);
}

export function computeDaySummary(tasks: DashboardTask[], now: Date): DaySummary {
  const completed = tasks.filter((t) => t.status === "completed").length;
  const remainingMinutes = tasks.reduce((sum, t) => {
    if (t.status === "completed" || t.status === "skipped") return sum;
    const effectiveStart = t.start > now ? t.start : now;
    if (t.end <= effectiveStart) return sum;
    return sum + (t.end.getTime() - effectiveStart.getTime()) / 60_000;
  }, 0);
  return { completed, total: tasks.length, remainingMinutes: Math.round(remainingMinutes) };
}

export const mockBriefingText = `Need to finish problem set 4 before econ study group, chem lab
questions are due today too. Grab groceries at some point, want to get a solid draft of the
politics essay done, and don't want to miss dinner with the roommates tonight. Also should
review Spanish vocab before tomorrow's quiz.`;
