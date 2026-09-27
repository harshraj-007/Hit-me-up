import "server-only";
import {
  pushSubscriptionInputSchema,
  revokePushSubscriptionInputSchema,
} from "@/lib/validation/push";
import { requireUserForAction } from "@/server/auth/session";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import {
  registerPushSubscription as registerPushSubscriptionRpc,
  revokePushSubscription as revokePushSubscriptionRpc,
} from "@/server/db/repositories/push-subscriptions";

/**
 * Registers (or refreshes) the caller's Web Push subscription for this browser/device
 * (Phase 6.1). `rawInput` is untrusted client input; the strict schema means it can only ever
 * name `endpoint`/`p256dh`/`authKey` — there is no field for a user id, so ownership always
 * comes from the authenticated session (`requireUserForAction`), never from the payload. This
 * uses the normal authenticated (RLS-scoped) Supabase client, exactly like every other
 * user-facing mutation — Phase 6.1 never touches the service-role path, which is reserved for
 * the later automation/delivery phase.
 */
export async function registerPushSubscription(rawInput: unknown): Promise<void> {
  await requireUserForAction();
  const input = pushSubscriptionInputSchema.parse(rawInput);
  const supabase = await createSupabaseServerClient();
  await registerPushSubscriptionRpc(supabase, input);
}

/**
 * Revokes the caller's own subscription for a given endpoint ("Turn off on this device").
 * Idempotent and silent on a foreign, missing, or already-revoked endpoint — see
 * `revoke_push_subscription` for why.
 */
export async function revokePushSubscription(rawInput: unknown): Promise<void> {
  await requireUserForAction();
  const { endpoint } = revokePushSubscriptionInputSchema.parse(rawInput);
  const supabase = await createSupabaseServerClient();
  await revokePushSubscriptionRpc(supabase, endpoint);
}
