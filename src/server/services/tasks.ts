import "server-only";
import { requireUserForAction } from "@/server/auth/session";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { createTask, changeTaskStatus, getTaskById } from "@/server/db/repositories/tasks";
import { checkTransition, type Task, type TaskStatus } from "@/domain/tasks";
import { createTaskInputSchema, updateTaskStatusInputSchema } from "@/lib/validation/task";
import { NotFoundError, ValidationError } from "@/server/errors";
import { revalidatePath } from "next/cache";
import { resolveCurrentDay } from "./day";

/**
 * Validates and persists a user-created task on the caller's *current* day (resolved
 * server-side — see resolveCurrentDay). `rawInput` is untrusted: it comes straight from the
 * Add Task dialog and is parsed with Zod before anything touches the database.
 */
export async function createTaskForToday(rawInput: unknown): Promise<Task> {
  const user = await requireUserForAction();
  const input = createTaskInputSchema.parse(rawInput);

  const supabase = await createSupabaseServerClient();
  const day = await resolveCurrentDay(supabase, user.id);

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

const RESOLVABLE_STATUSES = new Set<TaskStatus>(["completed", "skipped", "late"]);

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
