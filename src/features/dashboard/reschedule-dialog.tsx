"use client";

import { useId, useState, type FormEvent } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { wallTimeToUtc } from "@/domain/days";
import { taskDurationMs } from "@/domain/scheduling";
import type { Task } from "@/domain/tasks";
import {
  crossesMidnight,
  formatDuration,
  formatPlanningDate,
  formatTimeInput,
  formatWindow,
  localDateOf,
} from "@/lib/format/time";
import { rescheduleTaskAction } from "./actions";
import type { DashboardTask } from "./types";

export interface RescheduleDialogProps {
  task: DashboardTask;
  now: Date;
  onClose: () => void;
  onRescheduled: (task: Task) => void;
}

/**
 * Moves one task within ITS OWN planning day (`task.planningDate`, read in that day's frozen
 * timezone — never the browser's). Only the START can be chosen: the task keeps its duration and
 * the end is derived (`new end = new start + duration`), so a 90-minute task moved to 23:30 runs
 * 23:30 – 1:00 +1 day and still belongs to its own day. The server derives the end again from
 * the stored task and refuses any other end, so this preview is a convenience, not the rule.
 * There is no way to move a task to a different planning day.
 *
 * Mount it only while a task is being rescheduled (keyed by task id) so the field always starts
 * from that task. An overdue or unfitted task starts at the next 5-minute slot when that is
 * still on its day, since its old window is in the past or was never a real slot.
 */
export function RescheduleDialog({ task, now, onClose, onRescheduled }: RescheduleDialogProps) {
  const baseId = useId();
  const { planningDate, timezone } = task;
  const durationMs = taskDurationMs({ scheduledStart: task.start, scheduledEnd: task.end });
  const stale = task.status === "late" || task.status === "unscheduled";

  const slot = new Date(Math.ceil(now.getTime() / 300_000) * 300_000);
  const useSlot = stale && localDateOf(slot, timezone) === planningDate;

  const [start, setStart] = useState(formatTimeInput(useSlot ? slot : task.start, timezone));
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const startAt = /^\d{2}:\d{2}$/.test(start)
    ? wallTimeToUtc({ date: planningDate, time: start, timezone })
    : null;
  const endAt = startAt ? new Date(startAt.getTime() + durationMs) : null;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!startAt) return setError("Enter a valid start time.");
    setIsSubmitting(true);
    try {
      // Only the task and its new START are sent; the server derives the end.
      const result = await rescheduleTaskAction({ taskId: task.id, scheduledStart: startAt });
      if (!result.ok) {
        setError(result.error.issues?.[0]?.message ?? result.error.message);
        return;
      }
      onRescheduled(result.data);
      onClose();
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Reschedule task"
      description="Moves the task and keeps its length. Your choice is kept: replanning won't move a task you placed yourself. It stays on its own day."
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div>
          <p className="truncate text-sm font-medium">{task.title}</p>
          <p className="text-xs text-muted">
            Planned for {formatPlanningDate(planningDate)} · {formatDuration(durationMs / 60_000)}{" "}
            (fixed)
          </p>
        </div>

        <div>
          <label htmlFor={`${baseId}-start`} className="text-xs font-medium text-muted">
            New start
          </label>
          <input
            id={`${baseId}-start`}
            type="time"
            required
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm tabular-nums focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          />
        </div>

        {startAt && endAt ? (
          <p className="text-xs text-muted" aria-live="polite">
            {formatWindow(startAt, endAt, timezone)}
            {crossesMidnight(startAt, endAt, timezone) ? (
              <span className="ml-2 font-medium text-foreground">
                Ends next day — the task stays on {formatPlanningDate(planningDate)}
              </span>
            ) : null}
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-1 flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
