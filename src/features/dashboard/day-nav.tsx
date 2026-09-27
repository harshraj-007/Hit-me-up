"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, isPlanDateAllowed, lastPlanningDate } from "@/domain/days";

export interface DayNavProps {
  /** The day on screen (YYYY-MM-DD). */
  localDate: string;
  /** Today's local date in the profile timezone — the earliest date there is. */
  todayLocal: string;
}

const hrefFor = (date: string, todayLocal: string) =>
  date === todayLocal ? "/today" : `/today?date=${date}`;

/**
 * Previous / next / Today / a date picker, limited to today … today + 365. There is no
 * past-day navigation: "previous" is disabled on today and never goes before it. The server
 * re-validates every `?date=` and redirects anything out of range back to today, so these
 * limits are convenience, not the boundary.
 */
export function DayNav({ localDate, todayLocal }: DayNavProps) {
  const router = useRouter();
  const pickerId = useId();
  const last = lastPlanningDate(todayLocal);
  const prev = addDays(localDate, -1);
  const next = addDays(localDate, 1);
  const canPrev = isPlanDateAllowed(prev, todayLocal);
  const canNext = isPlanDateAllowed(next, todayLocal);

  const arrow =
    "inline-flex size-8 items-center justify-center rounded-md border border-border text-muted transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none";
  const disabled = `${arrow} pointer-events-none opacity-40`;

  return (
    <nav aria-label="Choose a day" className="mb-4 flex flex-wrap items-center gap-2">
      {canPrev ? (
        <Link href={hrefFor(prev, todayLocal)} className={arrow} aria-label="Previous day">
          <ChevronLeft aria-hidden className="size-4" />
        </Link>
      ) : (
        <span aria-disabled="true" className={disabled}>
          <ChevronLeft aria-hidden className="size-4" />
          <span className="sr-only">Previous day (not available)</span>
        </span>
      )}

      {localDate !== todayLocal ? (
        <Link
          href="/today"
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          Today
        </Link>
      ) : null}

      <label htmlFor={pickerId} className="sr-only">
        Planning date
      </label>
      <input
        id={pickerId}
        type="date"
        value={localDate}
        min={todayLocal}
        max={last}
        onChange={(event) => {
          const value = event.target.value;
          if (isPlanDateAllowed(value, todayLocal)) router.push(hrefFor(value, todayLocal));
        }}
        className="rounded-md border border-border bg-background px-2 py-1 text-xs tabular-nums focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      />

      {canNext ? (
        <Link href={hrefFor(next, todayLocal)} className={arrow} aria-label="Next day">
          <ChevronRight aria-hidden className="size-4" />
        </Link>
      ) : (
        <span aria-disabled="true" className={disabled}>
          <ChevronRight aria-hidden className="size-4" />
          <span className="sr-only">Next day (not available)</span>
        </span>
      )}
    </nav>
  );
}
