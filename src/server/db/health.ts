import "server-only";
import { getPublicEnv, isSupabaseConfigured } from "@/config/env.public";
import { logger } from "@/server/logging/logger";

export type DependencyStatus = "ok" | "unavailable" | "unconfigured";

const PROBE_TIMEOUT_MS = 3000;

/**
 * Verifies the server can reach Supabase using only the public anon key, via the auth
 * service's unauthenticated health route. It does not touch application tables, so it works
 * before any schema exists. Failure detail is logged, never returned.
 */
export async function probeDatabase(): Promise<DependencyStatus> {
  if (!isSupabaseConfigured()) return "unconfigured";
  const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: key } = getPublicEnv();
  try {
    const res = await fetch(new URL("/auth/v1/health", url), {
      headers: { apikey: key },
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("database probe returned non-2xx", { status: res.status });
      return "unavailable";
    }
    return "ok";
  } catch (err) {
    logger.warn("database probe failed", { err });
    return "unavailable";
  }
}
