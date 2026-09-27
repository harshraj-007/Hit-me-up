"use client";

import { useRef } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  Clock,
  Flag,
  Lock,
  Pin,
  Repeat,
  SkipForward,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { priorityStyles, statusStyles } from "@/lib/design/tokens";
import { pulseStatusIcon } from "@/lib/motion";
import { formatDuration, formatWindow, minutesBetween } from "@/lib/format/time";
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
  onReschedule: (id: string) => void;
  /** Overlaps another live task (shown, never auto-resolved for user-owned tasks). */
  hasConflict?: boolean;
  /** True while this task's own status change is in flight — disables its actions so a
   *  second click can't race the first (see DashboardView's pendingTaskId). */
  isPending?: boolean;
}

/** One row of the timeline. Status and priority are always paired with an icon + label. */
export function TaskItem({
  task,
  onComplete,
  onSkip,
  onReschedule,
  hasConflict = false,
  isPending = false,
}: TaskItemProps) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const status = statusStyles[task.status];
  const priority = priorityStyles[task.priority];
  const KindIcon = KIND_ICON[task.kind];
  const StatusIcon = status.icon;
  // Anything unresolved — including overdue (late) and unscheduled — can still be acted on.
  const actionable = task.status !== "completed" && task.status !== "skipped";

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
            {formatWindow(task.start, task.end, task.timezone)} ·{" "}
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
          {task.locked ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <Lock aria-hidden className="size-3" />
              Moved by you
            </span>
          ) : null}
          {hasConflict ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-status-late">
              <AlertTriangle aria-hidden className="size-3" />
              Overlaps another task
            </span>
          ) : null}
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
              onClick={() => onReschedule(task.id)}
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-xs font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <Clock aria-hidden className="size-3.5" />
              Reschedule
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}
