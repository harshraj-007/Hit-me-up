"use client";

import { useEffect, useRef, useState } from "react";
import { Flip, duration, ease, prefersReducedMotion, useGSAP, useEntrance } from "@/lib/motion";
import { EmptyState } from "@/components/ui/empty-state";
import type { DashboardTask } from "./types";
import { TaskItem } from "./task-item";
import { NowLine } from "./now-line";

const REFRESH_INTERVAL_MS = 30_000;

export interface TodayTimelineProps {
  tasks: DashboardTask[];
  onComplete: (id: string) => void;
  onSkip: (id: string) => void;
  onMarkLate: (id: string) => void;
  /** The task whose status change is currently being persisted, if any. */
  pendingTaskId?: string | null;
}

/**
 * The day as a single chronological list, with a live "Now" marker instead of a pixel-exact
 * calendar grid — calmer, and correct at any viewport without absolute-position math.
 * GSAP ownership: the whole list fades/lifts in on mount (useEntrance) and, when the Now
 * marker crosses a task boundary, Flip animates the resulting reflow instead of letting it
 * jump.
 */
export function TodayTimeline({
  tasks,
  onComplete,
  onSkip,
  onMarkLate,
  pendingTaskId = null,
}: TodayTimelineProps) {
  const [now, setNow] = useState(() => new Date());
  const listRef = useEntrance<HTMLUListElement>({
    selector: "[data-animate='task'], [data-now-line]",
    dependencies: [tasks],
  });
  const flipState = useRef<ReturnType<typeof Flip.getState> | null>(null);

  const nowIndex = tasks.findIndex((t) => t.start > now);
  const insertAt = nowIndex === -1 ? tasks.length : nowIndex;

  useEffect(() => {
    const id = setInterval(() => {
      if (listRef.current && !prefersReducedMotion()) {
        flipState.current = Flip.getState(Array.from(listRef.current.children));
      }
      setNow(new Date());
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- interval is set up once
  }, []);

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
    { dependencies: [insertAt] },
  );

  if (tasks.length === 0) {
    return (
      <EmptyState
        title="Nothing planned yet"
        description="Add a task to start building out today's timeline."
      />
    );
  }

  // A single keyed array (rather than three concatenated JSX fragments) so that when
  // `insertAt` shifts the Now marker's position, React matches every node — including the
  // marker itself — by key instead of by index. Without this, a position shift makes React
  // treat every task after it as a different element (wrong type at that index) and
  // remount it, which both loses task-level DOM state and makes useEntrance treat them as
  // brand-new nodes to fade in again.
  const items = [
    ...tasks.slice(0, insertAt).map((task) => ({ key: task.id, task })),
    { key: "now-line", task: null },
    ...tasks.slice(insertAt).map((task) => ({ key: task.id, task })),
  ];

  return (
    <ul ref={listRef} className="flex flex-col gap-1.5">
      {items.map((item) =>
        item.task ? (
          <TaskItem
            key={item.key}
            task={item.task}
            onComplete={onComplete}
            onSkip={onSkip}
            onMarkLate={onMarkLate}
            isPending={pendingTaskId === item.task.id}
          />
        ) : (
          <NowLine key={item.key} now={now} />
        ),
      )}
    </ul>
  );
}
