import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getPublicEnv } from "@/config/env.public";

/**
 * User-scoped Supabase client bound to the request's cookies (anon key + RLS).
 * This is the only client request-path code should use. The service-role client is deliberately
 * not created yet; it will live in its own module for cron/webhook jobs.
 */
export async function createSupabaseServerClient() {
  // Reading cookies first opts the calling route into per-request rendering, so authenticated
  // pages are never prerendered at build time (when env and session are absent).
  const cookieStore = await cookies();
  const env = getPublicEnv();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(toSet) {
        try {
          toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component, where cookies are read-only. Session refresh is
          // handled by the proxy once authentication lands (Phase 2).
        }
      },
    },
  });
}
