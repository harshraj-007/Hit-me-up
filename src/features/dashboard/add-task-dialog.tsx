"use client";

import { useId, useState, type FormEvent } from "react";
import clsx from "clsx";
import { addMinutes } from "date-fns";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { Task } from "@/domain/tasks";
import { createTaskAction } from "./actions";
import type { TaskPriority } from "./types";

export interface AddTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  now: Date;
  onCreated: (task: Task) => void;
}

const PRIORITIES: TaskPriority[] = ["high", "medium", "low"];

/**
 * Owns its own submission: it calls the server action directly, shows a Zod validation
 * error inline without closing, and only calls `onCreated` (letting the parent update local
 * state + show a success toast) once the task is actually persisted.
 */
export function AddTaskDialog({ open, onOpenChange, now, onCreated }: AddTaskDialogProps) {
  const baseId = useId();
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [minutesFromNow, setMinutesFromNow] = useState(30);
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setTitle("");
    setPriority("medium");
    setMinutesFromNow(30);
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
    setIsSubmitting(true);
    try {
      const start = addMinutes(now, Math.max(0, minutesFromNow));
      const result = await createTaskAction({
        title,
        priority,
        kind: "flexible",
        scheduledStart: start,
        scheduledEnd: addMinutes(start, Math.max(5, durationMinutes)),
      });
      if (!result.ok) {
        setError(result.error.issues?.[0]?.message ?? result.error.message);
        return;
      }
      onCreated(result.data);
      close();
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(next) : close())}
      title="Add a task"
      description="It's added straight to today's timeline — no scheduling conflicts are checked yet."
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
            className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${baseId}-start`} className="text-xs font-medium text-muted">
              Starts in (minutes)
            </label>
            <input
              id={`${baseId}-start`}
              type="number"
              min={0}
              step={5}
              value={minutesFromNow}
              onChange={(e) => setMinutesFromNow(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm tabular-nums focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            />
          </div>
          <div>
            <label htmlFor={`${baseId}-duration`} className="text-xs font-medium text-muted">
              Duration (minutes)
            </label>
            <input
              id={`${baseId}-duration`}
              type="number"
              min={5}
              step={5}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm tabular-nums focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            />
          </div>
        </div>

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
