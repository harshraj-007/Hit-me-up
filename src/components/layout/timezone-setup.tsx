"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { StatusPanel } from "@/components/ui/status-panel";
import { syncTimezoneAction } from "./timezone-actions";
import { reportTimezone } from "./timezone-report";

/** The browser's IANA zone. If it can't tell us, report "UTC" *explicitly* — a deliberate,
 *  user-visible-to-the-server choice, not a silent server-side placeholder. */
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Shown by the Today page on a user's first visit, when the server doesn't yet know their
 * timezone (and has therefore created no day). It reports the browser's zone and then asks the
 * server to render again, so the very first day the user sees is already the right one.
 *
 * Deliberately does NOT use TimezoneSync's `localStorage` shortcut: that cache isn't per-user,
 * so a second account on the same browser would wrongly skip reporting and be stuck here.
 */
export function TimezoneSetup() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // `cancelled` makes a superseded run (StrictMode's double effect, or a retry) harmless.
    let cancelled = false;
    void reportTimezone({
      sync: syncTimezoneAction,
      timezone: browserTimezone(),
      isCancelled: () => cancelled,
      onSaved: () => router.refresh(),
      onFailed: () => setFailed(true),
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, router]);

  if (failed) {
    return (
      <StatusPanel
        tone="error"
        title="Couldn't set up your day"
        description="We couldn't save your timezone. Check your connection and try again."
        action={{
          label: "Try again",
          onClick: () => {
            setFailed(false);
            setAttempt((n) => n + 1);
          },
        }}
      />
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 py-24 text-sm text-muted"
    >
      <Loader2 aria-hidden className="size-4 animate-spin" />
      Setting up your day…
    </div>
  );
}
