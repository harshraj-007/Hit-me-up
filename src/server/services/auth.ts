import "server-only";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { getPublicEnv } from "@/config/env.public";
import { emailInputSchema } from "@/lib/validation/auth";
import { ExternalServiceError } from "@/server/errors";

/**
 * Sends a passwordless sign-in link. This is the smallest real authentication mechanism
 * that makes the rest of Phase 3 (an actual "authenticated user") possible — Phase 1/2 only
 * ever built the `requireUser()` *guard*, never anything that could issue a session. See
 * PROJECT_ARCHITECTURE.md for why this was added in Phase 3 rather than assumed to already
 * exist.
 */
export async function requestMagicLink(rawInput: unknown): Promise<void> {
  const { email } = emailInputSchema.parse(rawInput);
  const supabase = await createSupabaseServerClient();
  const { NEXT_PUBLIC_APP_URL } = getPublicEnv();

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: new URL("/auth/callback", NEXT_PUBLIC_APP_URL).toString() },
  });

  // Supabase returns an error for things like rate limiting; it does not reveal whether the
  // email is a registered account, and neither should this — the caller already knows only
  // "a link was sent if that address is valid" either way.
  if (error) throw new ExternalServiceError("supabase", { cause: error });
}

export async function signOutCurrentUser(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signOut();
  if (error) throw new ExternalServiceError("supabase", { cause: error });
}
