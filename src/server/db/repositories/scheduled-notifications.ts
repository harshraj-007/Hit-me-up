import "server-only";
import { ExternalServiceError } from "@/server/errors";
import type { SupabaseServiceRoleClient } from "../supabase-service-role";
import type { Database } from "../database.types";

type ScheduledNotificationRow = Database["public"]["Tables"]["scheduled_notifications"]["Row"];

export type ScheduledNotificationStatus = ScheduledNotificationRow["status"];

export interface ScheduledNotification {
  id: string;
  userId: string;
  taskId: string;
  dayId: string;
  kind: ScheduledNotificationRow["kind"];
  fireAt: Date;
  taskScheduledStartSnapshot: Date;
  status: ScheduledNotificationStatus;
  claimedAt: Date | null;
  attemptCount: number;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function mapRow(row: ScheduledNotificationRow): ScheduledNotification {
  return {
    id: row.id,
    userId: row.user_id,
    taskId: row.task_id,
    dayId: row.day_id,
    kind: row.kind,
    fireAt: new Date(row.fire_at),
    taskScheduledStartSnapshot: new Date(row.task_scheduled_start_snapshot),
    status: row.status,
    claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
    attemptCount: row.attempt_count,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Reconciles `scheduled_notifications` against live `tasks`, then atomically claims whatever
 * is due — one call, one transaction (`reconcile_and_claim_notifications`, Phase 6.2). Returns
 * exactly the rows claimed by THIS invocation, never the whole table. Requires the
 * service-role client (`createSupabaseServiceRoleClient`); a normal user-scoped client has no
 * EXECUTE grant on this function at all and would fail with a permission error, by design.
 */
export async function reconcileAndClaimNotifications(
  supabase: SupabaseServiceRoleClient,
): Promise<ScheduledNotification[]> {
  const { data, error } = await supabase.rpc("reconcile_and_claim_notifications");
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return (data ?? []).map(mapRow);
}

/**
 * The ONE terminal transition Phase 6.3 itself performs (`mark_notification_sent`) — called
 * once a claimed notification had at least one successful Web Push provider acceptance. Every
 * other outcome (no active subscriptions, all transient failures, all permanently invalid
 * subscriptions) leaves the row `claimed` on purpose: Phase 6.2's own lease-recovery step
 * already decides, on a later cron tick, whether to retry or give up — see the migration and
 * PROJECT_ARCHITECTURE.md's Phase 6.3 section for why this needs no second attempt counter.
 * Idempotent and silent on a foreign, missing, or already-resolved id, same as every other
 * finalize/discard path in this codebase.
 */
export async function markNotificationSent(
  supabase: SupabaseServiceRoleClient,
  notificationId: string,
): Promise<void> {
  const { error } = await supabase.rpc("mark_notification_sent", {
    p_notification_id: notificationId,
  });
  if (error) throw new ExternalServiceError("supabase", { cause: error });
}
