import "server-only";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/server/db/supabase-server";

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

/** The only way server code should obtain a user ID. Redirects to /login when signed out. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
