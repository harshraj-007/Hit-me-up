"use client";

import { useActionState, useId } from "react";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestMagicLinkAction } from "@/server/auth/actions";
import type { ActionResult } from "@/server/errors";

async function action(_prev: ActionResult<null> | null, formData: FormData) {
  return requestMagicLinkAction(formData);
}

/** Passwordless sign-in: the only credential is proving you control the email address. */
export function LoginForm() {
  const [state, formAction, isPending] = useActionState(action, null);
  const emailId = useId();

  if (state?.ok) {
    return (
      <div role="status" className="rounded-md border border-border bg-surface-hover p-4 text-sm">
        <p className="font-medium">Check your email</p>
        <p className="mt-1 text-muted">
          We sent a sign-in link. It expires shortly, so use it soon.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div>
        <label htmlFor={emailId} className="text-xs font-medium text-muted">
          Email
        </label>
        <input
          id={emailId}
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        />
      </div>

      {state && !state.ok ? (
        <p role="alert" className="text-sm text-danger">
          {state.error.message}
        </p>
      ) : null}

      <Button type="submit" disabled={isPending} className="justify-center">
        <Mail aria-hidden className="size-4" />
        {isPending ? "Sending…" : "Send sign-in link"}
      </Button>
    </form>
  );
}
