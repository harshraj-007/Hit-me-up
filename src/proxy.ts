import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getPublicEnv } from "@/config/env.public";
import type { Database } from "@/server/db/database.types";

/**
 * Refreshes the Supabase session cookie on every request. Server Components can read
 * cookies but not write them (see supabase-server.ts), so without this a session nearing
 * its access-token expiry would never get refreshed and the user would eventually be
 * signed out mid-session. This does not itself enforce authentication — `requireUser()`
 * still does that per-route — it only keeps the session alive.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  let env: ReturnType<typeof getPublicEnv>;
  try {
    env = getPublicEnv();
  } catch {
    // Env isn't configured (e.g. a build-time probe) — nothing to refresh.
    return response;
  }

  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(toSet) {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  try {
    // The call itself (not just constructing the client) is what triggers a refresh.
    await supabase.auth.getUser();
  } catch {
    // Supabase unreachable — fail open. A route that actually needs auth still enforces it
    // itself (requireUser()/requireUserForAction()); this is only a best-effort refresh.
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Run on everything except static assets and image optimization files, so the session
     * cookie stays fresh for both pages and API/server-action requests.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
