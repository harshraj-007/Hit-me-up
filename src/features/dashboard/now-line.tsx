import { formatClock } from "@/lib/format/time";

/** The live "you are here" marker in the timeline list — see TodayTimeline for how it moves. */
export function NowLine({ now, timezone }: { now: Date; timezone: string }) {
  return (
    <li aria-hidden className="flex items-center gap-2 py-1" data-now-line>
      <span className="h-px flex-1 bg-status-current" />
      <span className="rounded-sm bg-status-current px-1.5 py-0.5 text-xs font-semibold text-accent-foreground tabular-nums">
        Now · {formatClock(now, timezone)}
      </span>
      <span className="h-px flex-1 bg-status-current" />
    </li>
  );
}
