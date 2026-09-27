"use client";

import { useId, useState, type FormEvent } from "react";
import clsx from "clsx";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  MAX_TASK_DURATION_MINUTES,
  MIN_TASK_DURATION_MINUTES,
  addDays,
  isPlanDateAllowed,
  lastPlanningDate,
  wallTimeToUtc,
} from "@/domain/days";
import type { Task } from "@/domain/tasks";
import {
  crossesMidnight,
  formatPlanningDate,
  formatWindow,
  formatTimeInput,
  localDateOf,
} from "@/lib/format/time";
import { createTaskAction } from "./actions";
import type { TaskPriority } from "./types";

export interface AddTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  now: Date;
  /** The planning day currently on screen, and its frozen timezone. */
  viewDate: string;
  viewTimezone: string;
  /** What a day that doesn't exist yet would be created with. */
  profileTimezone: string;
  todayLocal: string;
  /** `planningDate` is the day the task was planned for (which may not be the one on screen). */
  onCreated: (task: Task, planningDate: string) => void;
}

const PRIORITIES: TaskPriority[] = ["high", "medium", "low"];

/** Next 5-minute slot on the wall clock, kept inside the same day (23:55 at the latest). */
function suggestedStart(now: Date, timezone: string): string {
  const slot = new Date(Math.ceil(now.getTime() / 300_000) * 300_000);
  return localDateOf(slot, timezone) === localDateOf(now, timezone)
    ? formatTimeInput(slot, timezone)
    : "23:55";
}

/**
 * Add a task to a planning day the user picks (today by default, up to a year ahead) at an
 * explicit start time for an explicit duration. The wall time is turned into instants here in
 * the DAY's timezone — the browser's zone plays no part — and the window may run past midnight
 * (it is then shown as "ends next day" and still belongs to the day it was planned for).
 * Only the calendar date is sent for the day; the server resolves the actual day and re-checks
 * everything. Owns its own submission: shows a validation error inline without closing, and
 * calls `onCreated` only once the task is persisted.
 */
export function AddTaskDialog({
  open,
  onOpenChange,
  now,
  viewDate,
  viewTimezone,
  profileTimezone,
  todayLocal,
  onCreated,
}: AddTaskDialogProps) {
  const baseId = useId();
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [planningDate, setPlanningDate] = useState(viewDate);
  const [startTime, setStartTime] = useState(() => suggestedStart(now, viewTimezone));
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The day being added to decides the timezone: the one on screen keeps its own (frozen) zone,
  // any other date is a day that will be created with the profile's current zone.
  const timezone = planningDate === viewDate ? viewTimezone : profileTimezone;
  const dateOk = isPlanDateAllowed(planningDate, todayLocal);
  const durationOk =
    Number.isInteger(durationMinutes) &&
    durationMinutes >= MIN_TASK_DURATION_MINUTES &&
    durationMinutes <= MAX_TASK_DURATION_MINUTES;
  const start = /^\d{2}:\d{2}$/.test(startTime)
    ? wallTimeToUtc({ date: planningDate, time: startTime, timezone })
    : null;
  const end = start && durationOk ? new Date(start.getTime() + durationMinutes * 60_000) : null;

  function reset() {
    setTitle("");
    setPriority("medium");
    setPlanningDate(viewDate);
    setStartTime(suggestedStart(now, viewTimezone));
    setDurationMinutes(30);
    setError(null);
  }

  function close() {
    reset();
    onOpenChange(false);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!dateOk) return setError("Pick a date from today up to a year ahead.");
    if (!durationOk) {
      return setError(
        `Duration must be between ${MIN_TASK_DURATION_MINUTES} minutes and 24 hours (${MAX_TASK_DURATION_MINUTES} minutes).`,
      );
    }
    if (!start || !end) return setError("Choose a start time.");

    setIsSubmitting(true);
    try {
      const result = await createTaskAction({
        title,
        priority,
        kind: "flexible",
        scheduledStart: start,
        scheduledEnd: end,
        // Only a DATE is sent, and only when it isn't today (today is the server's default).
        ...(planningDate !== todayLocal ? { planningDate } : {}),
      });
      if (!result.ok) {
        setError(result.error.issues?.[0]?.message ?? result.error.message);
        return;
      }
      onCreated(result.data, planningDate);
      close();
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const inputClass =
    "mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm tabular-nums focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none";
  const quick =
    "rounded-md border border-border px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(next) : close())}
      title="Add a task"
      description="Pick the day and time. A task can run past midnight and still belongs to the day you plan it for; overlaps are flagged, not blocked."
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div>
          <label htmlFor={`${baseId}-title`} className="text-xs font-medium text-muted">
            Title
          </label>
          <input
            id={`${baseId}-title`}
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Reply to professor's email"
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor={`${baseId}-date`} className="text-xs font-medium text-muted">
            Planning day
          </label>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <input
              id={`${baseId}-date`}
              type="date"
              required
              min={todayLocal}
              max={lastPlanningDate(todayLocal)}
              value={planningDate}
              onChange={(e) => setPlanningDate(e.target.value)}
              className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm tabular-nums focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            />
            <button type="button" className={quick} onClick={() => setPlanningDate(todayLocal)}>
              Today
            </button>
            <button
              type="button"
              className={quick}
              onClick={() => setPlanningDate(addDays(todayLocal, 1))}
            >
              Tomorrow
            </button>
          </div>
          {dateOk ? (
            <p className="mt-1 text-xs text-muted">{formatPlanningDate(planningDate)}</p>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${baseId}-start`} className="text-xs font-medium text-muted">
              Starts
            </label>
            <input
              id={`${baseId}-start`}
              type="time"
              required
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={`${baseId}-duration`} className="text-xs font-medium text-muted">
              Duration (minutes)
            </label>
            <input
              id={`${baseId}-duration`}
              type="number"
              required
              min={MIN_TASK_DURATION_MINUTES}
              max={MAX_TASK_DURATION_MINUTES}
              step={5}
              value={Number.isNaN(durationMinutes) ? "" : durationMinutes}
              onChange={(e) => setDurationMinutes(Number(e.target.value))}
              className={inputClass}
            />
          </div>
        </div>

        {start && end ? (
          <p className="text-xs text-muted" aria-live="polite">
            {formatWindow(start, end, timezone)}
            {crossesMidnight(start, end, timezone) ? (
              <span className="ml-2 font-medium text-foreground">Ends next day</span>
            ) : null}
          </p>
        ) : null}

        <fieldset>
          <legend className="text-xs font-medium text-muted">Priority</legend>
          <div className="mt-1 flex gap-2">
            {PRIORITIES.map((p) => (
              <label
                key={p}
                className={clsx(
                  "flex-1 cursor-pointer rounded-md border px-2 py-1.5 text-center text-xs font-medium capitalize transition-colors",
                  priority === p
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border text-muted hover:bg-surface-hover",
                )}
              >
                <input
                  type="radio"
                  name="priority"
                  value={p}
                  checked={priority === p}
                  onChange={() => setPriority(p)}
                  className="sr-only"
                />
                {p}
              </label>
            ))}
          </div>
        </fieldset>

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
            onClick={close}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={isSubmitting}>
            {isSubmitting ? "Adding…" : "Add task"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
