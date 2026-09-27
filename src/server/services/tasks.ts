import "server-only";
import { requireUserForAction } from "@/server/auth/session";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import {
  applyReplan,
  changeTaskStatus,
  createTask,
  getTaskById,
  listSpilloverTasks,
  listTasksForDay,
  rescheduleTask,
} from "@/server/db/repositories/tasks";
import { findDayById, type Day } from "@/server/db/repositories/days";
import { checkTransition, type Task, type TaskStatus } from "@/domain/tasks";
import { addDays, dayBoundsUtc, isPlanDateAllowed } from "@/domain/days";
import {
  replanRemainingDay,
  shouldCreatePlanRevision,
  validateReschedule,
  validateTaskWindow,
  type ReplanResult,
} from "@/domain/scheduling";
import {
  createTaskInputSchema,
  rescheduleTaskInputSchema,
  updateTaskStatusInputSchema,
} from "@/lib/validation/task";
import { NotFoundError, ValidationError } from "@/server/errors";
import { localDateSchema } from "@/lib/validation/day";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { resolveCurrentDay, resolveDayForDate, todayLocalDate, viewDay } from "./day";

/**
 * Validates and persists a user-created task on a planning day the SERVER resolves: today by
 * default, or — when the client names a `planningDate` — that calendar date (today … today+365),
 * creating the day through ensure_day if it doesn't exist yet. The client never supplies a day
 * id. The window must start inside that day and last at most 24 hours; its END may cross
 * midnight, and the task still belongs to the day it was planned for. `rawInput` is untrusted
 * and parsed with Zod before anything touches the database.
 */
export async function createTaskForDay(rawInput: unknown): Promise<Task> {
  const user = await requireUserForAction();
  const input = createTaskInputSchema.parse(rawInput);

  const supabase = await createSupabaseServerClient();
  const day = input.planningDate
    ? await resolveDayForDate(supabase, user.id, input.planningDate)
    : await resolveCurrentDay(supabase, user.id);

  const bounds = dayBoundsUtc(day.localDate, day.timezone);
  if (bounds.end.getTime() <= Date.now()) {
    throw new ValidationError([{ path: "planningDate", message: "That day is already over." }]);
  }
  const window = validateTaskWindow(input.scheduledStart, input.scheduledEnd, bounds);
  if (!window.ok) {
    throw new ValidationError([{ path: "scheduledStart", message: window.reason }]);
  }

  const task = await createTask(supabase, {
    dayId: day.id,
    title: input.title,
    notes: input.notes ?? null,
    priority: input.priority,
    kind: input.kind,
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
    dueAt: input.dueAt ?? null,
  });

  revalidatePath("/today");
  return task;
}

const RESOLVABLE_STATUSES = new Set<TaskStatus>(["completed", "skipped"]);

/**
 * Validates and applies a status change. The transition is checked twice on purpose: once
 * here against the task's actual current status (so a user gets a clear "already resolved"
 * message), and again inside change_task_status() at the database layer (so the rule holds
 * even if this were ever called incorrectly) — see PROJECT_ARCHITECTURE.md.
 */
export async function updateTaskStatusForUser(rawInput: unknown): Promise<Task> {
  // Ownership is ultimately enforced by RLS and the RPC's own auth.uid() check below; this
  // call exists so an unauthenticated caller gets a clear "please sign in" error instead of
  // a confusing "task not found".
  await requireUserForAction();
  const input = updateTaskStatusInputSchema.parse(rawInput);

  const supabase = await createSupabaseServerClient();
  const current = await getTaskById(supabase, input.taskId);
  if (!current) throw new NotFoundError({ message: "Task not found." });

  const check = checkTransition(current.status, input.status);
  if (!check.ok) {
    throw new ValidationError([
      { path: "status", message: check.reason ?? "Invalid status change." },
    ]);
  }

  if (!RESOLVABLE_STATUSES.has(input.status)) {
    // Unreachable given the Zod schema's enum, but keeps this function honest about what
    // change_task_status() actually accepts.
    throw new ValidationError([
      { path: "status", message: `Cannot set status to ${input.status}.` },
    ]);
  }

  const task = await changeTaskStatus(supabase, input.taskId, input.status);

  revalidatePath("/today");
  return task;
}

/**
 * Moves an unresolved task by hand. Ownership is never taken from the browser: the caller's
 * identity comes from the verified session, and the task — and the planning day it belongs to —
 * are read under RLS, so another user's task or day is simply "not found". The window is
 * validated against the task's OWN planning day (not "today"): a task may start anywhere in its
 * day and, keeping its duration, end after midnight, and a previous day's spillover task can still be moved. A manual
 * move pins the task so a later replan can't undo it (the RPC sets `schedule_locked`).
 */
export async function rescheduleTaskForUser(rawInput: unknown): Promise<Task> {
  await requireUserForAction();
  const input = rescheduleTaskInputSchema.parse(rawInput);

  const supabase = await createSupabaseServerClient();
  const current = await getTaskById(supabase, input.taskId);
  if (!current) throw new NotFoundError({ message: "Task not found." });
  const day = await findDayById(supabase, current.dayId);
  if (!day) throw new NotFoundError({ message: "Task not found." });

  // The END comes from the task as stored, never from the caller: a reschedule moves the task
  // and keeps its duration. Everything else (planning-day start, ≤ 24h, not already over) is
  // validated against the task's OWN day.
  const check = validateReschedule(
    current,
    input.scheduledStart,
    dayBoundsUtc(day.localDate, day.timezone),
    new Date(),
  );
  if (!check.ok) {
    throw new ValidationError([{ path: "scheduledStart", message: check.reason }]);
  }

  const task = await rescheduleTask(supabase, input.taskId, check.start, check.end);
  revalidatePath("/today");
  return task;
}

export interface ReplanOutcome {
  /** The day's tasks after the replan — authoritative, re-read from the database. */
  tasks: Task[];
  /** Number of tasks whose persisted schedule changed. */
  changedCount: number;
  /** The plan revision this created, or null when the schedule was already up to date. */
  revisionNumber: number | null;
  unscheduled: ReplanResult["unscheduled"];
  conflicts: ReplanResult["conflicts"];
}

const replanInputSchema = z.object({ planningDate: localDateSchema.optional() }).optional();

const NOOP_OUTCOME: ReplanOutcome = {
  tasks: [],
  changedCount: 0,
  revisionNumber: null,
  unscheduled: [],
  conflicts: [],
};

/**
 * "Replan" the planning day the user is looking at — runs only when they ask. Today replans
 * what is LEFT of the day (from now); a future day is replanned over its WHOLE local day; a
 * future day with no row yet has nothing to replan and is a no-op. The client may name only a
 * date, never a day id. The pure planner receives the day's own tasks plus the previous day's
 * cross-midnight spillover; only the own day's planner tasks can move, the spillover is an
 * obstacle. Changes are persisted atomically (tasks + history + ONE revision) only if the
 * schedule actually changes.
 */
export async function replanDay(rawInput?: unknown): Promise<ReplanOutcome> {
  const user = await requireUserForAction();
  const input = replanInputSchema.parse(rawInput);
  const supabase = await createSupabaseServerClient();

  let day: Day;
  const today = await todayLocalDate(supabase, user.id);
  if (!today)
    throw new ValidationError([
      { path: "timezone", message: "Still setting up your timezone — please try again." },
    ]);
  const planningDate = input?.planningDate;
  if (planningDate && planningDate !== today.todayLocal) {
    if (!isPlanDateAllowed(planningDate, today.todayLocal)) {
      throw new ValidationError([
        { path: "planningDate", message: "Pick a date from today up to a year ahead." },
      ]);
    }
    const existing = await viewDay(supabase, user.id, planningDate);
    if (!existing) return NOOP_OUTCOME; // nothing planned there yet
    day = existing;
  } else {
    day = await resolveCurrentDay(supabase, user.id);
  }

  const now = new Date();
  const dayBounds = dayBoundsUtc(day.localDate, day.timezone);
  const previous = await viewDay(supabase, user.id, addDays(day.localDate, -1));
  const [tasks, spillover] = await Promise.all([
    listTasksForDay(supabase, day.id),
    previous ? listSpilloverTasks(supabase, previous.id, dayBounds.start) : Promise.resolve([]),
  ]);

  const result = replanRemainingDay({
    dayId: day.id,
    now,
    tasks: [...tasks, ...spillover],
    dayBounds,
  });

  if (!shouldCreatePlanRevision(result)) {
    return {
      tasks,
      changedCount: 0,
      revisionNumber: null,
      unscheduled: result.unscheduled,
      conflicts: result.conflicts,
    };
  }

  const revisionNumber = await applyReplan(supabase, day.id, result.changes);
  const updated = await listTasksForDay(supabase, day.id);
  revalidatePath("/today");
  return {
    tasks: updated,
    changedCount: result.changes.length,
    revisionNumber,
    unscheduled: result.unscheduled,
    conflicts: result.conflicts,
  };
}
