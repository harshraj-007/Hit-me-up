"use client";

import { Bell, BellOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePushNotifications } from "./use-push-notifications";

/**
 * The explicit, one-time "Enable notifications" affordance (Phase 6.1). Renders nothing while
 * still checking, and nothing when the feature genuinely isn't available (unsupported browser,
 * or the server hasn't configured a VAPID key yet) — an unsupported/unconfigured state is not
 * an error a user needs to see. Permission is requested ONLY from this button's own click
 * handler, never automatically.
 */
export function NotificationsControl() {
  const { state, enable, disable } = usePushNotifications();

  if (state === "checking" || state === "unsupported" || state === "not_configured") return null;

  if (state === "denied") {
    return <p className="px-3 text-xs text-muted">Notifications are blocked in your browser.</p>;
  }

  if (state === "on") {
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

  // state is "off" or "subscribing"
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={enable}
      disabled={state === "subscribing"}
      className="w-full justify-start gap-2 px-3 text-xs text-muted hover:text-foreground"
    >
      {state === "subscribing" ? (
        <Loader2 aria-hidden className="size-3.5 animate-spin" />
      ) : (
        <BellOff aria-hidden className="size-3.5" />
      )}
      {state === "subscribing" ? "Enabling…" : "Enable notifications"}
    </Button>
  );
}
