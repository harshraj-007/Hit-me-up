import "server-only";
import { ExternalServiceError } from "@/server/errors";
import type { SupabaseServerClient } from "../supabase-server";
import type { SupabaseServiceRoleClient } from "../supabase-service-role";
import type { Database } from "../database.types";

type PushSubscriptionRow = Database["public"]["Tables"]["push_subscriptions"]["Row"];

export interface PushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  authKey: string;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

function mapRow(row: PushSubscriptionRow): PushSubscription {
  return {
    id: row.id,
    userId: row.user_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    authKey: row.auth_key,
    createdAt: new Date(row.created_at),
    lastSeenAt: new Date(row.last_seen_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

/** `P0002` from `register_push_subscription`: the endpoint is already actively (unrevoked)
 *  registered to a different user — see the migration for why this is refused rather than
 *  silently reassigned. */
const ENDPOINT_TAKEN = "P0002";

export interface RegisterPushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  authKey: string;
}

/**
 * The only way a subscription row is created or refreshed (`register_push_subscription`,
 * Phase 6.1). Idempotent for the SAME user re-registering the same endpoint — keys and
 * `last_seen_at` refresh, and any prior revocation is cleared, so a revoked subscription
 * becomes active again simply by being re-registered by its own owner.
 */
export async function registerPushSubscription(
  supabase: SupabaseServerClient,
  input: RegisterPushSubscriptionInput,
): Promise<PushSubscription> {
  const { data, error } = await supabase.rpc("register_push_subscription", {
    p_endpoint: input.endpoint,
    p_p256dh: input.p256dh,
    p_auth_key: input.authKey,
  });
  if (error) {
    if (error.code === ENDPOINT_TAKEN) {
      throw new ExternalServiceError("supabase", {
        message: "This device is already registered elsewhere. Try again in a moment.",
        cause: error,
      });
    }
    throw new ExternalServiceError("supabase", { cause: error });
  }
  return mapRow(data);
}

/**
 * Revokes (never deletes) the caller's own subscription for `endpoint`
 * (`revoke_push_subscription`, Phase 6.1). Idempotent and silent on a foreign, missing, or
 * already-revoked endpoint — see the migration for why: none of those cases should look
 * different to the caller, and none reveals whether the endpoint exists or who owns it.
 */
export async function revokePushSubscription(
  supabase: SupabaseServerClient,
  endpoint: string,
): Promise<void> {
  const { error } = await supabase.rpc("revoke_push_subscription", { p_endpoint: endpoint });
  if (error) throw new ExternalServiceError("supabase", { cause: error });
}

/**
 * Every ACTIVE (`revoked_at is null`) subscription for a user — the system/delivery path's
 * only read (Phase 6.3). Takes the service-role client deliberately: there is no user session
 * on the cron/delivery path to scope a `SupabaseServerClient` read to, and this is the one
 * place this repository crosses users on purpose — the delivery service is the trusted system
 * boundary that fans a claimed notification out to its OWN user's devices, verified by
 * `notification.userId`, never by anything a client supplied.
 */
export async function listActiveSubscriptionsForUser(
  supabase: SupabaseServiceRoleClient,
  userId: string,
): Promise<PushSubscription[]> {
  const { data, error } = await supabase
    .from("push_subscriptions")
    .select("*")
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return (data ?? []).map(mapRow);
}

/**
 * The system-facing revocation path (`revoke_push_subscription_by_id`, Phase 6.3) — used only
 * when the Web Push provider reports a subscription permanently gone (404/410). Unlike
 * `revokePushSubscription` above, this is addressed by the subscription's own id (which
 * delivery already has from `listActiveSubscriptionsForUser`) and authorized by the caller
 * being the trusted service-role path, not by ownership — see the migration for why there is
 * no ownership check to bypass here. Idempotent and silent on a foreign, missing, or
 * already-revoked id, same as every other revoke/discard path in this codebase.
 */
export async function revokePushSubscriptionById(
  supabase: SupabaseServiceRoleClient,
  subscriptionId: string,
): Promise<void> {
  const { error } = await supabase.rpc("revoke_push_subscription_by_id", {
    p_subscription_id: subscriptionId,
  });
  if (error) throw new ExternalServiceError("supabase", { cause: error });
}
