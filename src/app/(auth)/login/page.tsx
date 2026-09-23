import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getCurrentUser()) redirect("/today");
  const { error } = await searchParams;

  return (
    <main className="mx-auto max-w-sm px-4 py-24">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="mt-2 text-sm text-muted">
        Enter your email and we&rsquo;ll send you a link — no password to remember.
      </p>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-danger">
          That sign-in link didn&rsquo;t work — it may have expired. Request a new one below.
        </p>
      ) : null}
      <div className="mt-6">
        <LoginForm />
      </div>
    </main>
  );
}
