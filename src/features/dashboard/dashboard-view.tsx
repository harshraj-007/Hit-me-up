"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast-provider";
import { useEntrance } from "@/lib/motion";
import type { Task, TaskStatus } from "@/domain/tasks";
import { updateTaskStatusAction, saveBriefingAction } from "./actions";
import { AddTaskDialog } from "./add-task-dialog";
import { BriefingPanel } from "./briefing-panel";
import { DashboardHeader } from "./dashboard-header";
import { toDashboardTask } from "./map-task";
import { computeDaySummary } from "./summary";
import { TodayTimeline } from "./today-timeline";
import type { DashboardTask } from "./types";

const CLOCK_INTERVAL_MS = 60_000;

function byStart(a: DashboardTask, b: DashboardTask) {
  return a.start.getTime() - b.start.getTime();
}

export interface DashboardViewProps {
  initialTasks: Task[];
  initialBriefingText: string;
  /** The instant the server snapshot was computed — the starting point for the client's
   *  own ticking clock, and what "current" was derived against for `initialTasks`. */
  initialNow: Date;
}

/**
 * Owns Today-page UI state. The data itself lives in Postgres: every mutation here calls a
 * Server Action (src/features/dashboard/actions.ts) and only updates local state from what
 * that action actually persisted — never optimistically, so there's nothing to roll back if
 * it fails (see PROJECT_ARCHITECTURE.md's Phase 3 notes on this choice).
 */
export function DashboardView({
  initialTasks,
  initialBriefingText,
  initialNow,
}: DashboardViewProps) {
  const [tasks, setTasks] = useState<DashboardTask[]>(() =>
    initialTasks.map((t) => toDashboardTask(t, initialNow)).sort(byStart),
  );
  const [briefingText, setBriefingText] = useState(initialBriefingText);
  const [now, setNow] = useState(initialNow);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [isSavingBriefing, setIsSavingBriefing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const { toast } = useToast();
  const scope = useEntrance<HTMLDivElement>({
    selector: "[data-animate='section']",
    stagger: 0.08,
  });

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), CLOCK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const summary = useMemo(() => computeDaySummary(tasks, now), [tasks, now]);

  async function handleStatusChange(
    taskId: string,
    status: Extract<TaskStatus, "completed" | "skipped" | "late">,
  ) {
    if (pendingTaskId) return; // one mutation at a time is plenty for a single-user dashboard
    setPendingTaskId(taskId);
    try {
      const result = await updateTaskStatusAction({ taskId, status });
      if (!result.ok) {
        toast({ title: "Couldn't update task", description: result.error.message, tone: "error" });
        return;
      }
      const updated = toDashboardTask(result.data, now);
      setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)));
      const label =
        status === "completed"
          ? "Marked complete"
          : status === "skipped"
            ? "Skipped"
            : "Marked late";
      toast({
        title: label,
        description: updated.title,
        tone: status === "completed" ? "success" : "neutral",
      });
    } finally {
      setPendingTaskId(null);
    }
  }

  function handleCreated(task: Task) {
    setTasks((prev) => [...prev, toDashboardTask(task, now)].sort(byStart));
    toast({ title: "Task added", description: task.title, tone: "success" });
  }

  async function handleSaveBriefing(text: string) {
    setIsSavingBriefing(true);
    try {
      const result = await saveBriefingAction({ rawText: text });
      if (!result.ok) {
        toast({
          title: "Couldn't save briefing",
          description: result.error.message,
          tone: "error",
        });
        return;
      }
      setBriefingText(result.data.rawText);
      toast({ title: "Briefing saved", tone: "success" });
    } finally {
      setIsSavingBriefing(false);
    }
  }

  return (
    <div ref={scope}>
      <DashboardHeader now={now} summary={summary} />

      {/*
        Mobile/tablet: a single flex column, briefing above timeline (`order-first`).
        Desktop (lg+): a two-column grid — timeline as the main column, briefing as a
        sticky side rail — rather than the mobile layout simply stretched wider. Source
        order stays timeline-then-briefing at every width (the timeline is the primary
        content), only the visual `order` changes.
      */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[1fr_20rem] lg:items-start xl:grid-cols-[1fr_22rem] xl:gap-8">
        <section
          data-animate="section"
          aria-labelledby="timeline-heading"
          className="order-last lg:order-1"
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 id="timeline-heading" className="text-sm font-semibold">
              Today&rsquo;s timeline
            </h2>
            <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
              <Plus aria-hidden className="size-4" />
              Add task
            </Button>
          </div>
          <TodayTimeline
            tasks={tasks}
            pendingTaskId={pendingTaskId}
            onComplete={(id) => void handleStatusChange(id, "completed")}
            onSkip={(id) => void handleStatusChange(id, "skipped")}
            onMarkLate={(id) => void handleStatusChange(id, "late")}
          />
        </section>

        <div className="order-first lg:sticky lg:top-6 lg:order-2">
          <BriefingPanel
            initialText={briefingText}
            isSaving={isSavingBriefing}
            onSave={handleSaveBriefing}
          />
        </div>
      </div>

      <AddTaskDialog open={addOpen} onOpenChange={setAddOpen} now={now} onCreated={handleCreated} />
    </div>
  );
}
