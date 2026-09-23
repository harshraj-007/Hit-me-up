"use client";

import { useRef } from "react";
import clsx from "clsx";
import {
  ArrowLeftRight,
  Check,
  Clock,
  Flag,
  Pin,
  Repeat,
  SkipForward,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { priorityStyles, statusStyles } from "@/lib/design/tokens";
import { pulseStatusIcon } from "@/lib/motion";
import { formatDuration, formatRange, minutesBetween } from "@/lib/format/time";
import type { DashboardTask, TaskKind } from "./types";

const KIND_ICON: Record<TaskKind, LucideIcon> = {
  fixed: Pin,
  flexible: ArrowLeftRight,
  deadline: Flag,
  optional: Clock,
  recurring: Repeat,
};

const KIND_LABEL: Record<TaskKind, string> = {
  fixed: "Fixed",
  flexible: "Flexible",
  deadline: "Deadline",
  optional: "Optional",
  recurring: "Recurring",
};

export interface TaskItemProps {
  task: DashboardTask;
  onComplete: (id: string) => void;
  onSkip: (id: string) => void;
  onMarkLate: (id: string) => void;
  /** True while this task's own status change is in flight — disables its actions so a
   *  second click can't race the first (see DashboardView's pendingTaskId). */
  isPending?: boolean;
}

/** One row of the timeline. Status and priority are always paired with an icon + label. */
export function TaskItem({
  task,
  onComplete,
  onSkip,
  onMarkLate,
  isPending = false,
}: TaskItemProps) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const status = statusStyles[task.status];
  const priority = priorityStyles[task.priority];
  const KindIcon = KIND_ICON[task.kind];
  const StatusIcon = status.icon;
  const actionable = task.status === "upcoming" || task.status === "current";

  function runAction(action: (id: string) => void) {
    void pulseStatusIcon(iconRef.current);
    action(task.id);
  }

  return (
    <li
      data-animate="task"
      className={clsx(
        "flex gap-3 rounded-md border-l-2 py-2.5 pr-2 pl-3 transition-colors",
        status.border,
        task.status === "current" ? status.soft : "hover:bg-surface-hover",
      )}
    >
      <span ref={iconRef} className={clsx("mt-0.5 inline-flex shrink-0", status.text)}>
        <StatusIcon aria-hidden className="size-4" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p
            className={clsx(
              "truncate text-sm font-medium",
              task.status === "completed" && "text-muted line-through",
              task.status === "skipped" && "text-muted",
            )}
          >
            {task.title}
          </p>
          <p className="shrink-0 text-xs text-muted tabular-nums">
            {formatRange(task.start, task.end)} ·{" "}
            {formatDuration(minutesBetween(task.start, task.end))}
          </p>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={clsx("inline-flex items-center gap-1 text-xs font-medium", status.text)}>
            <StatusIcon aria-hidden className="size-3" />
            {status.label}
          </span>
          <Badge label={priority.label} toneText={priority.text} toneSoft={priority.soft} />
          <span className="inline-flex items-center gap-1 text-xs text-muted">
            <KindIcon aria-hidden className="size-3" />
            {KIND_LABEL[task.kind]}
          </span>
        </div>

        {task.note ? <p className="mt-1 text-xs text-muted">{task.note}</p> : null}

        {actionable ? (
          <div className="mt-2 flex gap-1" aria-busy={isPending}>
            <button
              type="button"
              disabled={isPending}
              onClick={() => runAction(onComplete)}
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-xs font-medium text-status-completed transition-colors hover:bg-status-completed-soft disabled:pointer-events-none disabled:opacity-40"
            >
              <Check aria-hidden className="size-3.5" />
              Complete
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => runAction(onSkip)}
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-xs font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <SkipForward aria-hidden className="size-3.5" />
              Skip
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => runAction(onMarkLate)}
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-xs font-medium text-status-late transition-colors hover:bg-status-late-soft disabled:pointer-events-none disabled:opacity-40"
            >
              <Clock aria-hidden className="size-3.5" />
              Mark late
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}
