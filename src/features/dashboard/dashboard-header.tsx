"use client";

import { useEffect, useRef } from "react";
import { animateValue } from "@/lib/motion";
import { formatDayHeading, formatDuration } from "@/lib/format/time";
import type { DaySummary } from "./types";

function getGreeting(hour: number): string {
  if (hour < 12) return "Good morning.";
  if (hour < 17) return "Good afternoon.";
  return "Good evening.";
}

export function DashboardHeader({ now, summary }: { now: Date; summary: DaySummary }) {
  const completedRef = useRef<HTMLSpanElement>(null);
  const previousCompleted = useRef(summary.completed);

  useEffect(() => {
    void animateValue(completedRef.current, {
      from: previousCompleted.current,
      to: summary.completed,
    });
    previousCompleted.current = summary.completed;
  }, [summary.completed]);

  return (
    <header data-animate="section" className="mb-6">
      <p className="text-sm text-muted">{formatDayHeading(now)}</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{getGreeting(now.getHours())}</h1>
      <p className="mt-2 text-sm text-muted">
        <span ref={completedRef} className="font-medium text-foreground">
          {summary.completed}
        </span>{" "}
        of {summary.total} done
        {summary.remainingMinutes > 0
          ? ` · ${formatDuration(summary.remainingMinutes)} left today`
          : null}
      </p>
    </header>
  );
}
