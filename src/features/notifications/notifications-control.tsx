"use client";

import { Bell, BellOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePushNotifications } from "./use-push-notifications";

/**
 * The explicit, one-time "Enable notifications" affordance (Phase 6.1, wired into the mount-time
 * capability/state model in Phase 6.5). Renders nothing while still checking, and nothing when
 * the feature genuinely isn't available (unsupported browser, or the server hasn't configured a
 * VAPID key yet) — an unsupported/unconfigured state is not an error a user needs to see.
 * Permission is requested ONLY from this button's own click handler (inside `enable()`), never
 * automatically. `subscribing` and `registering` are rendered identically on purpose — the
 * control communicates capability/state, not this feature's internal step boundaries.
 */
export function NotificationsControl() {
  const { state, enable, disable } = usePushNotifications();

  if (state === "checking" || state === "unsupported" || state === "not_configured") return null;

  if (state === "permission_denied") {
    return (
      <p className="px-3 text-xs text-muted">
        Notifications are blocked in your browser. Allow notifications in your browser settings to
        enable reminders.
      </p>
    );
  }

  if (state === "enabled") {
    return (
      <div className="flex items-center justify-between gap-2 px-3">
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <Bell aria-hidden className="size-3.5" />
          Notifications on
        </span>
        <Button variant="ghost" size="sm" onClick={disable} className="h-7 px-2 text-xs">
          Turn off
        </Button>
      </div>
    );
  }

  if (state === "revoking") {
    return (
      <p className="flex items-center gap-1.5 px-3 text-xs text-muted">
        <Loader2 aria-hidden className="size-3.5 animate-spin" />
        Turning off…
      </p>
    );
  }

  // state is "permission_default", "permission_granted", "subscribing", "registering", or "error"
  const isLoading = state === "subscribing" || state === "registering";
  return (
    <div className="px-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={enable}
        disabled={isLoading}
        className="w-full justify-start gap-2 px-2 text-xs text-muted hover:text-foreground"
      >
        {isLoading ? (
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
        ) : (
          <BellOff aria-hidden className="size-3.5" />
        )}
        {isLoading ? "Enabling…" : "Enable notifications"}
      </Button>
      {state === "error" ? (
        <p role="alert" className="px-2 text-xs text-danger">
          Couldn&apos;t enable notifications. Try again.
        </p>
      ) : null}
    </div>
  );
}
