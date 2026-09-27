import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getPublicEnv } from "@/config/env.public";
import { getServiceRoleKey } from "@/config/env.server";
import type { Database } from "./database.types";

/**
 * The ONE deliberate exception to this codebase's "no service-role client anywhere" rule
 * (see `supabase-server.ts`). It bypasses RLS entirely, so it must never be used on a
 * user-facing request path — only `src/app/api/cron/notifications/route.ts` (Phase 6.2's
 * CRON_SECRET-gated system path) may call this. It is never constructed from, or exposed to,
 * client code: `SUPABASE_SERVICE_ROLE_KEY` is read exclusively through `getServerEnv()`
 * (server-only), and this whole module is unimportable from a Client Component.
 *
 * Unlike `createSupabaseServerClient`, this needs no request cookies — a service-role key is
 * its own credential, not a user session — so `auth.autoRefreshToken`/`persistSession` are
 * both off: there is no session to refresh or persist.
 *
 * Returns `null`, rather than throwing, when the key isn't configured — matching every other
 * optional-config accessor in this project (`getAiConfig`, `getVapidPublicKey`); the caller
 * (the cron route) turns that into a clear 500, distinct from an authorization failure.
 */
export function createSupabaseServiceRoleClient() {
  const serviceRoleKey = getServiceRoleKey();
  if (!serviceRoleKey) return null;
  const { NEXT_PUBLIC_SUPABASE_URL } = getPublicEnv();
  return createClient<Database>(NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type SupabaseServiceRoleClient = NonNullable<
  ReturnType<typeof createSupabaseServiceRoleClient>
>;
