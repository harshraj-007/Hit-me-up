"use client";

import { useEffect, useRef } from "react";
import { animateValue } from "@/lib/motion";
import {
  formatClock,
  formatDayHeading,
  formatDuration,
  formatPlanningDate,
  localHour,
} from "@/lib/format/time";
import type { DayProgress } from "@/domain/tasks";

function getGreeting(hour: number): string {
  if (hour < 12) return "Good morning.";
  if (hour < 17) return "Good afternoon.";
  return "Good evening.";
}

export interface DashboardHeaderProps {
  now: Date;
  /** The DAY's timezone — every time on screen is read in it, never in the browser's. */
  timezone: string;
  viewState: "today" | "future";
  localDate: string;
  /** Computed from the day's OWN tasks only; spillover from the previous day is not in it. */
  progress: DayProgress;
  remainingMinutes: number;
}

export function DashboardHeader({
  now,
  timezone,
  viewState,
  localDate,
  progress,
  remainingMinutes,
}: DashboardHeaderProps) {
  const completedRef = useRef<HTMLSpanElement>(null);
  const previousCompleted = useRef(progress.completed);

  useEffect(() => {
    void animateValue(completedRef.current, {
      from: previousCompleted.current,
      to: progress.completed,
    });
    previousCompleted.current = progress.completed;
  }, [progress.completed]);

  if (viewState === "future") {
    return (
      <header data-animate="section" className="mb-6">
        <p className="text-sm text-muted">Planning ahead</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Planning for {formatPlanningDate(localDate)}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {progress.total === 0
            ? "Nothing planned yet."
            : `${progress.total} ${progress.total === 1 ? "task" : "tasks"} planned` +
              (remainingMinutes > 0 ? ` · ${formatDuration(remainingMinutes)}` : "")}
        </p>
      </header>
    );
  }

  return (
    <header data-animate="section" className="mb-6">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-muted">{formatDayHeading(now, timezone)}</p>
        <p className="text-sm font-medium tabular-nums" aria-label="Current time">
          {formatClock(now, timezone)}
        </p>
      </div>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">
        {getGreeting(localHour(now, timezone))}
      </h1>

      {progress.ratio !== null ? (
        <>
          <p className="mt-2 text-sm text-muted">
            <span ref={completedRef} className="font-medium text-foreground">
              {progress.completed}
            </span>{" "}
            of {progress.countable} done
            {remainingMinutes > 0 ? ` · ${formatDuration(remainingMinutes)} left today` : null}
          </p>
          <div
            role="progressbar"
            aria-label="Day progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress.ratio * 100)}
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-hover"
          >
            <div
              className="h-full rounded-full bg-status-completed transition-[width] duration-500 ease-out"
              style={{ width: `${Math.round(progress.ratio * 100)}%` }}
            />
          </div>
        </>
      ) : null}
    </header>
  );
}
