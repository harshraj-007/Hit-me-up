import "server-only";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { AuthenticationError } from "@/server/errors";

export interface SessionUser {
  id: string;
  email: string | null;
}

/**
 * Resolves the user from the verified auth token (`getUser` revalidates with Supabase; it
 * never trusts an unverified cookie or any client-supplied ID).
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

/** The only way a page/layout should obtain a user ID. Redirects to /login when signed out. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * The Server Action equivalent of `requireUser()`. A redirect thrown from inside an action
 * invoked by, say, a "mark complete" click would silently navigate the user away — not what
 * anyone wants for a background mutation — so this throws an `AuthenticationError` instead,
 * which `runAction()` turns into a normal `{ ok: false }` result the UI can show as a toast.
 */
export async function requireUserForAction(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user)
    throw new AuthenticationError({ message: "Your session has expired. Please sign in again." });
  return user;
}
