"use client";

import { useImperativeHandle, useRef, type Ref } from "react";
import { Flip, duration, ease, prefersReducedMotion, useGSAP, useEntrance } from "@/lib/motion";
import { EmptyState } from "@/components/ui/empty-state";
import type { DashboardTask } from "./types";
import { TaskItem } from "./task-item";
import { NowLine } from "./now-line";

/** Lets the owner snapshot the list's layout right before it changes (GSAP Flip needs the
 *  "before" positions), without the timeline owning any clock or data of its own. */
export interface TimelineHandle {
  captureLayout: () => void;
}

export interface TodayTimelineProps {
  tasks: DashboardTask[];
  /** The previous day's unresolved tasks still running into this day. Shown first, labelled,
   *  and kept out of this day's list, progress and Now-marker placement. */
  spillover?: DashboardTask[];
  spilloverLabel?: string;
  /** The Now marker belongs to today only; a future day has no "now". */
  showNow?: boolean;
  /** The day's own timezone, for the Now marker's clock. */
  timezone: string;
  /** The dashboard's single shared clock. */
  now: Date;
  /** Ids of tasks that overlap another live task. */
  conflictIds: ReadonlySet<string>;
  onComplete: (id: string) => void;
  onSkip: (id: string) => void;
  onReschedule: (id: string) => void;
  /** The task whose status change is currently being persisted, if any. */
  pendingTaskId?: string | null;
  handleRef?: Ref<TimelineHandle>;
}

const byStart = (a: DashboardTask, b: DashboardTask) =>
  a.start.getTime() - b.start.getTime() || a.id.localeCompare(b.id);

/**
 * The day as a single chronological list with a live "Now" marker, plus — below it — the
 * tasks a replan couldn't fit (they hold no slot, so they don't belong on the time axis).
 * GSAP ownership: the whole list fades/lifts in on mount (useEntrance) and Flip animates any
 * reflow — the Now marker crossing a boundary, a reschedule, a replan.
 */
export function TodayTimeline({
  tasks,
  spillover = [],
  spilloverLabel = "From yesterday",
  showNow = true,
  timezone,
  now,
  conflictIds,
  onComplete,
  onSkip,
  onReschedule,
  pendingTaskId = null,
  handleRef,
}: TodayTimelineProps) {
  const scheduled = tasks.filter((t) => t.status !== "unscheduled").sort(byStart);
  const unscheduled = tasks.filter((t) => t.status === "unscheduled").sort(byStart);

  const listRef = useEntrance<HTMLUListElement>({
    selector: "[data-animate='task'], [data-now-line]",
    dependencies: [tasks],
  });
  const flipState = useRef<ReturnType<typeof Flip.getState> | null>(null);

  const nowIndex = scheduled.findIndex((t) => t.start > now);
  // With no Now marker (a future day) nothing is inserted; -1 keeps the layout key stable.
  const insertAt = !showNow ? -1 : nowIndex === -1 ? scheduled.length : nowIndex;

  useImperativeHandle(handleRef, () => ({
    captureLayout() {
      if (listRef.current && !prefersReducedMotion()) {
        flipState.current = Flip.getState(Array.from(listRef.current.children));
      }
    },
  }));

  // Changes whenever order, times or the Now marker's position change — and only then.
  const layoutKey =
    scheduled.map((t) => `${t.id}:${t.start.getTime()}:${t.end.getTime()}`).join("|") +
    `@${insertAt}`;

  useGSAP(
    () => {
      if (!flipState.current || !listRef.current) return;
      Flip.from(flipState.current, {
        targets: listRef.current.children,
        duration: duration.base,
        ease: ease.inOut,
        absolute: true,
      });
      flipState.current = null;
    },
    { dependencies: [layoutKey] },
  );

  if (tasks.length === 0 && spillover.length === 0) {
    return (
      <EmptyState
        title="Nothing planned yet"
        description="Add a task to start building out today's timeline."
      />
    );
  }

  // A single keyed array (rather than concatenated JSX fragments) so that when `insertAt`
  // shifts the Now marker, React matches every node — including the marker — by key instead of
  // by index. Otherwise a shift would remount every later task, dropping DOM state and making
  // useEntrance fade the whole list in again.
  const items =
    insertAt === -1
      ? scheduled.map((task) => ({ key: task.id, task }))
      : [
          ...scheduled.slice(0, insertAt).map((task) => ({ key: task.id, task })),
          { key: "now-line", task: null },
          ...scheduled.slice(insertAt).map((task) => ({ key: task.id, task })),
        ];

  return (
    <div>
      {spillover.length > 0 ? (
        <section aria-labelledby="spillover-heading" className="mb-4">
          <h3 id="spillover-heading" className="text-sm font-semibold">
            {spilloverLabel}
          </h3>
          <p className="mt-0.5 mb-2 text-xs text-muted">
            Still running past midnight. They stay on their own day and don&rsquo;t count toward
            this day&rsquo;s progress, but they take up time here.
          </p>
          <ul className="flex flex-col gap-1.5">
            {spillover.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                onComplete={onComplete}
                onSkip={onSkip}
                onReschedule={onReschedule}
                isPending={pendingTaskId === task.id}
                hasConflict={conflictIds.has(task.id)}
              />
            ))}
          </ul>
        </section>
      ) : null}
      <ul ref={listRef} className="flex flex-col gap-1.5">
        {items.map((item) =>
          item.task ? (
            <TaskItem
              key={item.key}
              task={item.task}
              onComplete={onComplete}
              onSkip={onSkip}
              onReschedule={onReschedule}
              isPending={pendingTaskId === item.task.id}
              hasConflict={conflictIds.has(item.task.id)}
            />
          ) : (
            <NowLine key={item.key} now={now} timezone={timezone} />
          ),
        )}
      </ul>

      {unscheduled.length > 0 ? (
        <section aria-labelledby="unscheduled-heading" className="mt-5">
          <h3 id="unscheduled-heading" className="text-sm font-semibold text-status-late">
            Couldn&rsquo;t fit today
          </h3>
          <p className="mt-0.5 mb-2 text-xs text-muted">
            These didn&rsquo;t fit in the time that&rsquo;s left. Nothing was deleted or shortened —
            reschedule, complete or skip them.
          </p>
          <ul className="flex flex-col gap-1.5">
            {unscheduled.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                onComplete={onComplete}
                onSkip={onSkip}
                onReschedule={onReschedule}
                isPending={pendingTaskId === task.id}
                hasConflict={false}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
