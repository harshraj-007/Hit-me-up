import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getPublicEnv } from "@/config/env.public";
import type { Database } from "./database.types";

/**
 * User-scoped Supabase client bound to the request's cookies (anon key + RLS).
 * This is the only client request-path code should use. There is deliberately no
 * service-role client anywhere in this codebase — every table has RLS policies that let an
 * authenticated user reach exactly their own rows, so nothing needs to bypass it.
 * `middleware.ts` refreshes the session cookie on every request; without it, an expired
 * access token set from a Server Component (which can only read, not write, cookies) would
 * eventually strand the user signed out.
 */
export async function createSupabaseServerClient() {
  // Reading cookies first opts the calling route into per-request rendering, so authenticated
  // pages are never prerendered at build time (when env and session are absent).
  const cookieStore = await cookies();
  const env = getPublicEnv();
  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll(toSet) {
          try {
            toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Called from a Server Component, where cookies are read-only — expected, and
            // harmless because middleware.ts already refreshed the cookie for this request.
          }
        },
      },
    },
  );
}

export type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;
