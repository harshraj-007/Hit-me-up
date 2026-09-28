import "server-only";
import {
  AiConfirmationError,
  ExternalServiceError,
  NotFoundError,
  ValidationError,
} from "@/server/errors";
import type { ConfirmationChange } from "@/domain/ai-planning";
import type { ScheduleChange } from "@/domain/scheduling";
import type { Task, TaskKind, TaskPriority, TaskSource, TaskStatus } from "@/domain/tasks";
import type { SupabaseServerClient } from "../supabase-server";
import type { SupabaseServiceRoleClient } from "../supabase-service-role";
import type { Database } from "../database.types";

type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];

/** PL/pgSQL "no_data_found" — the task RPCs raise this when the target row didn't match
 *  (missing, not owned, or no longer "upcoming"). See the migrations for the SQL. */
const NO_DATA_FOUND = "P0002";
/** `invalid_parameter_value` — a window the database itself refuses (e.g. outside the day). */
const INVALID_PARAMETER = "22023";
/** `serialization_failure` — apply_replan() raises it when a task changed after the replan
 *  was computed from a now-stale read. */
const STALE_WRITE = "40001";
/** `exclusion_violation` — confirm_ai_proposal() raises it when the resulting schedule
 *  conflicts. See supabase/migrations/20260928090000_phase53_confirm_ai_proposal.sql. */
const SCHEDULE_CONFLICT = "23P01";

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    userId: row.user_id,
    dayId: row.day_id,
    title: row.title,
    notes: row.notes,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    kind: row.kind as TaskKind,
    source: row.source as TaskSource,
    scheduledStart: new Date(row.scheduled_start),
    scheduledEnd: new Date(row.scheduled_end),
    dueAt: row.due_at ? new Date(row.due_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    scheduleLocked: row.schedule_locked,
    unscheduled: row.unscheduled,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export async function listTasksForDay(
  supabase: SupabaseServerClient,
  dayId: string,
): Promise<Task[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("day_id", dayId)
    .order("scheduled_start", { ascending: true });

  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return data.map(mapTask);
}

/**
 * Yesterday's unresolved tasks that are still running into `dayStart` — the cross-midnight
 * "spillover". They keep belonging to their own planning day (`previousDayId`); this only
 * reads them so the next day can show them and plan around them. Unscheduled tasks hold no
 * slot and are excluded. One query, by day id, using the existing (day_id, scheduled_start) index.
 */
export async function listSpilloverTasks(
  supabase: SupabaseServerClient,
  previousDayId: string,
  dayStart: Date,
): Promise<Task[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("day_id", previousDayId)
    .eq("status", "upcoming")
    .eq("unscheduled", false)
    .gt("scheduled_end", dayStart.toISOString())
    .order("scheduled_start", { ascending: true });
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return data.map(mapTask);
}

export interface NewTask {
  dayId: string;
  title: string;
  notes: string | null;
  priority: TaskPriority;
  kind: TaskKind;
  scheduledStart: Date;
  scheduledEnd: Date;
  dueAt: Date | null;
}

/** Persists a user-created task and its initial history row atomically (see the
 *  create_task_with_history() RPC in the migration). `source` is always "user" here —
 *  nothing in this phase creates a "planner"-sourced task. */
export async function createTask(supabase: SupabaseServerClient, input: NewTask): Promise<Task> {
  const { data, error } = await supabase.rpc("create_task_with_history", {
    p_day_id: input.dayId,
    p_title: input.title,
    p_notes: input.notes,
    p_priority: input.priority,
    p_kind: input.kind,
    p_scheduled_start: input.scheduledStart.toISOString(),
    p_scheduled_end: input.scheduledEnd.toISOString(),
    p_due_at: input.dueAt ? input.dueAt.toISOString() : null,
    p_source: "user",
  });

  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return mapTask(data);
}

/**
 * Moves a task out of "upcoming" and records the transition, atomically (see the
 * change_task_status() RPC). Throws NotFoundError — never a raw DB error — when the row
 * doesn't exist, isn't the caller's, or is no longer "upcoming"; callers that want a
 * friendlier message for the last case should check with the domain layer first (the
 * service layer does).
 */
export async function changeTaskStatus(
  supabase: SupabaseServerClient,
  taskId: string,
  newStatus: Extract<TaskStatus, "completed" | "skipped">,
): Promise<Task> {
  const { data, error } = await supabase.rpc("change_task_status", {
    p_task_id: taskId,
    p_new_status: newStatus,
  });

  if (error) {
    if (error.code === NO_DATA_FOUND) {
      throw new NotFoundError({ message: "Task not found.", cause: error });
    }
    throw new ExternalServiceError("supabase", { cause: error });
  }
  return mapTask(data);
}

export async function getTaskById(
  supabase: SupabaseServerClient,
  taskId: string,
): Promise<Task | null> {
  const { data, error } = await supabase.from("tasks").select("*").eq("id", taskId).maybeSingle();
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return data ? mapTask(data) : null;
}

/**
 * A task's title ONLY (Phase 6.3's Web Push payload builder — see
 * `src/lib/notifications/task-reminder-payload.ts`) — deliberately not `getTaskById`, and not
 * a service-role variant of it: the notification payload must never carry `notes` (an explicit
 * security rule), and selecting only `title` here makes that structurally true rather than a
 * discipline the payload builder has to remember to uphold. Takes the service-role client:
 * there is no user session on the delivery path, and `notification.taskId`/`userId` (from the
 * authoritative claimed row, never client input) are what establish which task this is.
 */
export async function getTaskTitleForDelivery(
  supabase: SupabaseServiceRoleClient,
  taskId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("tasks")
    .select("title")
    .eq("id", taskId)
    .maybeSingle();
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return data?.title ?? null;
}

/** Moves one unresolved task and pins it, atomically with its history row and a "user" plan
 *  revision (see reschedule_task()). No-op writes (same window) create neither. */
export async function rescheduleTask(
  supabase: SupabaseServerClient,
  taskId: string,
  start: Date,
  end: Date,
): Promise<Task> {
  const { data, error } = await supabase.rpc("reschedule_task", {
    p_task_id: taskId,
    p_start: start.toISOString(),
    p_end: end.toISOString(),
  });
  if (error) {
    if (error.code === NO_DATA_FOUND) {
      throw new NotFoundError({ message: "Task not found.", cause: error });
    }
    if (error.code === INVALID_PARAMETER) {
      throw new ValidationError(
        [{ path: "scheduledStart", message: "That time isn't valid for today." }],
        {
          cause: error,
        },
      );
    }
    throw new ExternalServiceError("supabase", { cause: error });
  }
  return mapTask(data);
}

/** Wire shape of one element of apply_replan()'s `p_changes` (snake_case, ISO strings). */
export interface ReplanChangeRow {
  task_id: string;
  previous_start: string;
  previous_end: string;
  previous_unscheduled: boolean;
  new_start: string;
  new_end: string;
  new_unscheduled: boolean;
}

export function toReplanChangeRow(change: ScheduleChange): ReplanChangeRow {
  return {
    task_id: change.taskId,
    previous_start: change.previousStart.toISOString(),
    previous_end: change.previousEnd.toISOString(),
    previous_unscheduled: change.previousUnscheduled,
    new_start: change.newStart.toISOString(),
    new_end: change.newEnd.toISOString(),
    new_unscheduled: change.newUnscheduled,
  };
}

/**
 * Applies a replan atomically (see apply_replan()): every task update, its history row and
 * exactly one "system" plan revision commit together or not at all. Returns the new revision
 * number, or null when nothing changed. A task that changed since the replan was computed
 * makes the whole thing fail with a ValidationError the user can retry.
 */
export async function applyReplan(
  supabase: SupabaseServerClient,
  dayId: string,
  changes: readonly ScheduleChange[],
): Promise<number | null> {
  const { data, error } = await supabase.rpc("apply_replan", {
    p_day_id: dayId,
    p_changes: changes.map(toReplanChangeRow),
  });
  if (error) {
    if (error.code === STALE_WRITE) {
      throw new ValidationError([], {
        message: "Your schedule changed while replanning. Please try again.",
        cause: error,
      });
    }
    if (error.code === NO_DATA_FOUND) {
      throw new NotFoundError({ message: "Day not found.", cause: error });
    }
    throw new ExternalServiceError("supabase", { cause: error });
  }
  return data;
}

/** Wire shape of one element of confirm_ai_proposal()'s `p_changes` (snake_case, ISO strings).
 *  `new_start` is present only for a `move` — never an end time, never a duration. */
export interface ConfirmChangeRow {
  ref: string;
  task_id: string;
  type: "move" | "unschedule";
  new_start?: string;
}

export function toConfirmChangeRow(change: ConfirmationChange): ConfirmChangeRow {
  return change.kind === "move"
    ? {
        ref: change.ref,
        task_id: change.taskId,
        type: "move",
        new_start: change.newStart.toISOString(),
      }
    : { ref: change.ref, task_id: change.taskId, type: "unschedule" };
}

/**
 * Applies a human-confirmed AI proposal atomically (see confirm_ai_proposal()): the database
 * independently re-verifies ownership, current eligibility, the window, the base revision and
 * the resulting conflicts before writing anything — the ValidationResult the caller already
 * computed is not trusted here. Returns the new revision number. Every failure aborts the
 * entire call; nothing is ever partially applied.
 */
export async function confirmAiProposal(
  supabase: SupabaseServerClient,
  dayId: string,
  baseRevision: number,
  changes: readonly ConfirmationChange[],
): Promise<number> {
  const { data, error } = await supabase.rpc("confirm_ai_proposal", {
    p_day_id: dayId,
    p_base_revision: baseRevision,
    p_changes: changes.map(toConfirmChangeRow),
  });
  if (error) {
    if (error.code === STALE_WRITE)
      throw new AiConfirmationError("stale_revision", { cause: error });
    if (error.code === NO_DATA_FOUND)
      throw new AiConfirmationError("task_ineligible", { cause: error });
    if (error.code === SCHEDULE_CONFLICT)
      throw new AiConfirmationError("conflict", { cause: error });
    if (error.code === INVALID_PARAMETER)
      throw new AiConfirmationError("invalid_proposal", { cause: error });
    throw new ExternalServiceError("supabase", { cause: error });
  }
  return data;
}
