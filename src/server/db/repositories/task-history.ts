import "server-only";
import type { TaskHistoryEntry, TaskStatus } from "@/domain/tasks";
import { ExternalServiceError } from "@/server/errors";
import type { SupabaseServerClient } from "../supabase-server";
import type { Database } from "../database.types";

type HistoryRow = Database["public"]["Tables"]["task_history"]["Row"];

/** Rows per `in (...)` query: bounds the request size, whatever the day holds. */
const CHUNK = 50;

function mapEntry(row: HistoryRow): TaskHistoryEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    event: row.event,
    // History keeps accepting the legacy 'late' status (rows recorded under the pre-Phase-4 model
    // are never rewritten). It is not a persisted TASK status any more; nothing here interprets it.
    previousStatus: row.previous_status as TaskStatus | null,
    newStatus: row.new_status as TaskStatus,
    source: row.source,
    previousStart: row.previous_start ? new Date(row.previous_start) : null,
    previousEnd: row.previous_end ? new Date(row.previous_end) : null,
    newStart: row.new_start ? new Date(row.new_start) : null,
    newEnd: row.new_end ? new Date(row.new_end) : null,
    revisionId: row.revision_id,
    changedAt: new Date(row.changed_at),
  };
}

/**
 * Read-only. `task_history` is append-only and written only by the task RPCs; this only reads it,
 * under the caller's own RLS (the owner-scoped SELECT policy), for the end-of-day review's
 * "what moved" facts. The caller names the tasks — always ones it already read for the day — so a
 * foreign id could only ever match nothing.
 */
export async function listTaskHistoryForTasks(
  supabase: SupabaseServerClient,
  taskIds: readonly string[],
): Promise<TaskHistoryEntry[]> {
  const entries: TaskHistoryEntry[] = [];
  for (let i = 0; i < taskIds.length; i += CHUNK) {
    const { data, error } = await supabase
      .from("task_history")
      .select("*")
      .in("task_id", taskIds.slice(i, i + CHUNK))
      .order("changed_at", { ascending: true });
    if (error) throw new ExternalServiceError("supabase", { cause: error });
    entries.push(...data.map(mapEntry));
  }
  return entries;
}
