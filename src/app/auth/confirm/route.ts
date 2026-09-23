import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { logger } from "@/server/logging/logger";
import { safeInternalPath } from "@/lib/validation/redirect";
import type { EmailOtpType } from "@supabase/supabase-js";

/**
 * Verifies a magic-link email OTP via its token_hash, then sends the user on to `next`
 * (default /today; anything that isn't a plain same-site path is replaced by /today — see
 * safeInternalPath). This is the intended target of the magic-link email once the Supabase
 * "Magic Link" template points here with `token_hash={{ .TokenHash }}` instead of the
 * default `{{ .ConfirmationURL }}` (which points at Supabase's own `/auth/v1/verify` and
 * comes back as a PKCE `?code=`, handled by ../callback).
 *
 * NOT YET ACTIVE: the hosted project is on the free tier with Supabase's default email
 * provider, which refuses custom templates, so today's emails still use the default template
 * and ../callback. This route is ready for when custom SMTP or a paid plan is in place.
 *
 * That distinction is deliberate, not stylistic: `verifyOtp({ token_hash, type })` is a
 * single self-contained call — the token_hash IS the proof of possession — so it works no
 * matter what browser or device opens the link. The PKCE `code` flow in ../callback instead
 * needs a `code_verifier` the *same browser* stashed in a cookie when the flow started,
 * which an email link — almost always opened from a mail client, not the browser tab that
 * requested it — usually isn't. That mismatch ("PKCE code verifier not found in storage")
 * is what broke magic-link sign-in before this route existed; see PROJECT_ARCHITECTURE.md.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  // `next` is attacker-controllable (it's a query param on a link) — never redirect to it raw.
  const next = safeInternalPath(searchParams.get("next"));

  if (tokenHash && type) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) return NextResponse.redirect(new URL(next, origin));
    logger.warn("auth confirm failed to verify token_hash", { err: error });
  }

  return NextResponse.redirect(new URL("/login?error=auth", origin));
}
