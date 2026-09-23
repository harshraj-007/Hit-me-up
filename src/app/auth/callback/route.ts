import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { logger } from "@/server/logging/logger";

/** Exchanges the magic-link code for a session, then sends the user on to Today. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/today", origin));
    logger.warn("auth callback failed to exchange code", { err: error });
  }

  return NextResponse.redirect(new URL("/login?error=auth", origin));
}
