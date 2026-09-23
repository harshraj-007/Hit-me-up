import "server-only";
import { ExternalServiceError, NotFoundError } from "@/server/errors";
import type { Task, TaskKind, TaskPriority, TaskSource, TaskStatus } from "@/domain/tasks";
import type { SupabaseServerClient } from "../supabase-server";
import type { Database } from "../database.types";

type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];

/** PL/pgSQL "no_data_found" — change_task_status() raises this when the target row didn't
 *  match (missing, not owned, or no longer "upcoming"). See the migration for the SQL. */
const NO_DATA_FOUND = "P0002";

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
  newStatus: Extract<TaskStatus, "completed" | "skipped" | "late">,
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
