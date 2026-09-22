import { Loader2 } from "lucide-react";

/** Stand-in for the real AI planning call (arrives in a later phase). */
export function PlanGenerating() {
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-md border border-dashed border-border bg-surface-hover px-3 py-2 text-sm text-muted"
    >
      <Loader2 aria-hidden className="size-4 animate-spin" />
      Re-reading your day and rebuilding the plan…
    </div>
  );
}
