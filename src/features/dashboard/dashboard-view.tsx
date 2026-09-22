"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast-provider";
import { useEntrance } from "@/lib/motion";
import { applyMockReplan, buildMockDay, computeDaySummary } from "@/mock/today";
import { AddTaskDialog } from "./add-task-dialog";
import { BriefingPanel } from "./briefing-panel";
import { DashboardHeader } from "./dashboard-header";
import { TodayTimeline } from "./today-timeline";
import type { DashboardTask, TaskStatus } from "./types";

const REPLAN_DELAY_MS = 1400;
const CLOCK_INTERVAL_MS = 60_000;

function byStart(a: DashboardTask, b: DashboardTask) {
  return a.start.getTime() - b.start.getTime();
}

/**
 * Owns all Today-page state. Everything here is client-local mock state — no persistence,
 * no server calls — so the visual shell can be exercised end to end before Phase 3 wires
 * up the database and Phase 4 wires up real AI planning.
 */
export function DashboardView() {
  const [dayAnchor] = useState(() => new Date());
  const [tasks, setTasks] = useState<DashboardTask[]>(() => buildMockDay(dayAnchor));
  const [now, setNow] = useState(() => new Date());
  const [isGenerating, setIsGenerating] = useState(false);
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

  function setStatus(
    id: string,
    status: TaskStatus,
    toastOptions: { title: string; tone?: "success" },
  ) {
    const task = tasks.find((t) => t.id === id);
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
    toast({ ...toastOptions, description: task?.title });
  }

  function handleAdd(task: DashboardTask) {
    setTasks((prev) => [...prev, task].sort(byStart));
    toast({ title: "Task added", description: task.title, tone: "success" });
  }

  function handleReplan() {
    setIsGenerating(true);
    window.setTimeout(() => {
      setTasks((prev) => applyMockReplan(prev, now));
      setIsGenerating(false);
      toast({
        title: "Day replanned",
        description: "Updated today's plan around what changed.",
        tone: "success",
      });
    }, REPLAN_DELAY_MS);
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
            onComplete={(id) =>
              setStatus(id, "completed", { title: "Marked complete", tone: "success" })
            }
            onSkip={(id) => setStatus(id, "skipped", { title: "Skipped" })}
            onMarkLate={(id) =>
              setStatus(id, "late", { title: "Marked late — it'll need a new slot" })
            }
          />
        </section>

        <div className="order-first lg:sticky lg:top-6 lg:order-2">
          <BriefingPanel isGenerating={isGenerating} onReplan={handleReplan} />
        </div>
      </div>

      <AddTaskDialog open={addOpen} onOpenChange={setAddOpen} now={now} onAdd={handleAdd} />
    </div>
  );
}
