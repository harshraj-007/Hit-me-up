import "server-only";
import { createHash } from "node:crypto";
import {
  MAX_EOD_TASKS,
  computeEodFacts,
  eodStateCanonical,
  type EodReport,
  type EodReportView,
} from "@/domain/eod";
import type { Task } from "@/domain/tasks";
import { createAnthropicEodInterpreter } from "@/server/ai/anthropic-eod";
import type { EodInterpreter } from "@/server/ai/eod-port";
import { EOD_PROMPT_VERSION } from "@/server/ai/eod-prompt";
import { generateEodInterpretation } from "@/server/ai/generate-eod";
import { requireUserForAction } from "@/server/auth/session";
import {
  createEodReport,
  findEodReportForState,
  findLatestEodReport,
} from "@/server/db/repositories/eod-reports";
import { listRevisionNumbers } from "@/server/db/repositories/plan-revisions";
import { listTaskHistoryForTasks } from "@/server/db/repositories/task-history";
import { listTasksForDay } from "@/server/db/repositories/tasks";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { ValidationError } from "@/server/errors";
import { logger } from "@/server/logging/logger";
import { todayLocalDate, viewDay } from "./day";

/** sha-256 (hex) of the persisted task state — what `eod_reports.state_fingerprint` stores. */
export function fingerprintTasks(tasks: readonly Task[]): string {
  return createHash("sha256").update(eodStateCanonical(tasks)).digest("hex");
}

export interface EodReportDeps {
  /** Defaults to the Anthropic adapter; tests inject a fake through the same port. */
  interpreter?: EodInterpreter;
  now?: () => Date;
  signal?: AbortSignal;
}

export type GenerateEodResult =
  /** The day has no tasks: there is nothing to review, no model is called and nothing is stored. */
  { kind: "empty" } | { kind: "report"; view: EodReportView; reused: boolean };

/**
 * Phase 7 — the end-of-day review for the caller's CURRENT planning day.
 *
 *   authenticated user → today's day (resolved server-side; the client names NO date, id or user)
 *   → the day's own tasks, read under the caller's RLS
 *   → fingerprint of their persisted state → an existing report for that exact state? return it
 *   → task history + plan revisions → DETERMINISTIC facts (computeEodFacts)
 *   → EodInterpreter (the model sees the facts, never ids, notes, or identity)
 *   → Zod shape → deterministic validator → persist a snapshot via create_eod_report
 *
 * The model can only interpret: every number, time, title, outcome and reschedule count in the
 * stored report was computed here from the database. Nothing is written except that one report row
 * (append-only; `tasks`, `task_history` and `plan_revisions` are never touched), and a model or
 * validation failure persists nothing. Calling this twice against an unchanged day costs one
 * database read and no model call: the report for that exact state is returned.
 *
 * Cross-midnight: a task belongs to the planning day it was created on, so a task starting late
 * today and ending after midnight is reviewed here, today; a task that started yesterday and is
 * still running today is yesterday's, and is not part of this report.
 */
export async function generateEodReport(deps: EodReportDeps = {}): Promise<GenerateEodResult> {
  const user = await requireUserForAction();
  const now = (deps.now ?? (() => new Date()))();
  const supabase = await createSupabaseServerClient();

  const clock = await todayLocalDate(supabase, user.id);
  if (!clock) {
    throw new ValidationError([
      { path: "timezone", message: "Still setting up your timezone — please try again." },
    ]);
  }

  // Read-only: reviewing a day never creates one. Only today is reviewable from here — there is no
  // date parameter to point it at a future (or other) day.
  const day = await viewDay(supabase, user.id, clock.todayLocal);
  if (!day) {
    throw new ValidationError([{ path: "day", message: "There's nothing planned today yet." }]);
  }

  // RLS already scopes this read to the caller; the filter is a second, independent check.
  const tasks = (await listTasksForDay(supabase, day.id)).filter(
    (t) => t.userId === user.id && t.dayId === day.id,
  );
  if (tasks.length === 0) return { kind: "empty" };
  if (tasks.length > MAX_EOD_TASKS) {
    throw new ValidationError([
      { path: "day", message: "That's more tasks than one review can cover." },
    ]);
  }

  const stateFingerprint = fingerprintTasks(tasks);
  const existing = await findEodReportForState(supabase, day.id, stateFingerprint);
  if (existing) {
    return { kind: "report", view: { report: existing, isStale: false }, reused: true };
  }

  const [history, revisions] = await Promise.all([
    listTaskHistoryForTasks(
      supabase,
      tasks.map((t) => t.id),
    ),
    listRevisionNumbers(supabase, day.id),
  ]);

  const facts = computeEodFacts({
    planningDate: day.localDate,
    timezone: day.timezone, // the day's frozen zone, not the profile's current one
    now,
    tasks,
    history,
    revisions,
  });

  const interpreter = deps.interpreter ?? createAnthropicEodInterpreter();
  const { interpretation, dropped } = await generateEodInterpretation(interpreter, facts, {
    signal: deps.signal,
  });
  if (dropped.length > 0) {
    logger.info("eod interpretation entries dropped by validation", {
      droppedCount: dropped.length,
    });
  }

  const report = await createEodReport(supabase, {
    dayId: day.id,
    stateFingerprint,
    promptVersion: EOD_PROMPT_VERSION,
    facts,
    interpretation,
  });
  return { kind: "report", view: { report, isStale: false }, reused: false };
}

/**
 * Read-only: the day's report as the Today page should show it, plus whether the day has changed
 * since it was written — no model call. `tasks` is the page's own read of the day's tasks, so
 * staleness costs no extra query for them. The newest report is the one shown unless an OLDER one
 * was written against exactly the day's current state (a task moved back to where it was): that
 * one is current, whatever its age, and showing the newer, stale one would be wrong.
 */
export async function loadEodReportView(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  dayId: string,
  tasks: readonly Task[],
): Promise<EodReportView | null> {
  const latest: EodReport | null = await findLatestEodReport(supabase, dayId);
  if (!latest) return null;
  const current = fingerprintTasks(tasks);
  if (latest.stateFingerprint === current) return { report: latest, isStale: false };
  const matching = await findEodReportForState(supabase, dayId, current);
  return matching ? { report: matching, isStale: false } : { report: latest, isStale: true };
}
