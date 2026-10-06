"use client";

import { useMemo, useRef, useState } from "react";
import { CalendarClock, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast-provider";
import { useEntrance } from "@/lib/motion";
import { addDays, dayBoundsUtc } from "@/domain/days";
import { calculateDayProgress, type Task, type TaskStatus } from "@/domain/tasks";
import { detectScheduleConflicts } from "@/domain/scheduling";
import { formatPlanningDate } from "@/lib/format/time";
import { replanRemainingDayAction, saveBriefingAction, updateTaskStatusAction } from "./actions";
import { AddTaskDialog } from "./add-task-dialog";
import { BriefingPanel } from "./briefing-panel";
import { DashboardHeader } from "./dashboard-header";
import { DayNav } from "./day-nav";
import { EodPanel } from "./eod/eod-panel";
import { toDashboardTask } from "./map-task";
import { RescheduleDialog } from "./reschedule-dialog";
import type { EodReportView } from "@/domain/eod";
import { AiPlanDialog } from "./ai-planning/ai-plan-dialog";
import type { ProposalView } from "./ai-planning/proposal-view";
import { computeRemainingMinutes } from "./summary";
import { TodayTimeline, type TimelineHandle } from "./today-timeline";
import { useNow } from "./use-now";

export interface DashboardViewProps {
  viewState: "today" | "future";
  /** Null for a future date that has no day row yet (viewing never creates one). */
  dayId: string | null;
  localDate: string;
  todayLocal: string;
  /** This day's own (frozen) timezone — every time on screen is read in it. */
  timezone: string;
  /** What a not-yet-created day would be stamped with. */
  profileTimezone: string;
  /** The previous day's date and frozen timezone, for its spillover tasks. */
  previousDay: { localDate: string; timezone: string } | null;
  initialTasks: Task[];
  /** Previous-day tasks still running into this day. */
  initialSpillover: Task[];
  initialBriefingText: string;
  /** The instant the server snapshot was computed — the shared clock's starting point, so
   *  server and client render the same thing on first paint. */
  initialNow: Date;
  /** A pending AI proposal the server already found for this day (Phase 5.5 resume), or null. */
  initialPendingAiProposal: ProposalView | null;
  /** Today's saved end-of-day review, if one was written (Phase 7); always null for a future day. */
  initialEodReport: EodReportView | null;
}

/**
 * Owns one planning day's UI state. The data lives in Postgres: every mutation calls a Server
 * Action (src/features/dashboard/actions.ts) and only updates local state from what that
 * action actually persisted — never optimistically, so there is nothing to roll back.
 *
 * The persisted `Task[]` is the state; what each task looks like *right now* (upcoming,
 * current, late…) is derived from it and the shared clock at render time, in the DAY's
 * timezone, so the clock moving never writes anything. Progress is computed from this day's own
 * tasks only; the previous day's spillover is displayed and planned around but never counted.
 */
export function DashboardView({
  viewState,
  dayId,
  localDate,
  todayLocal,
  timezone,
  profileTimezone,
  previousDay,
  initialTasks,
  initialSpillover,
  initialBriefingText,
  initialNow,
  initialPendingAiProposal,
  initialEodReport,
}: DashboardViewProps) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [spillover, setSpillover] = useState<Task[]>(initialSpillover);
  const [dayExists, setDayExists] = useState(dayId !== null);
  const [briefingText, setBriefingText] = useState(initialBriefingText);
  const [addOpen, setAddOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiMode, setAiMode] = useState<"ask" | "briefing">("ask");
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [isReplanning, setIsReplanning] = useState(false);
  const [isSavingBriefing, setIsSavingBriefing] = useState(false);
  const { toast } = useToast();
  const scope = useEntrance<HTMLDivElement>({ selector: "[data-animate='section']" });
  const timelineRef = useRef<TimelineHandle>(null);

  const captureLayout = () => timelineRef.current?.captureLayout();
  const now = useNow(initialNow, captureLayout);

  const bounds = useMemo(() => dayBoundsUtc(localDate, timezone), [localDate, timezone]);
  const ownDay = useMemo(() => ({ localDate, timezone }), [localDate, timezone]);
  const prevDay = useMemo(
    () => previousDay ?? { localDate: addDays(localDate, -1), timezone },
    [previousDay, localDate, timezone],
  );

  /** Previous-day tasks that still overlap this day's start: unresolved and scheduled. */
  const visibleSpillover = useMemo(
    () =>
      spillover.filter(
        (t) => t.status === "upcoming" && !t.unscheduled && t.scheduledEnd > bounds.start,
      ),
    [spillover, bounds.start],
  );

  const dashboardTasks = useMemo(
    () => tasks.map((t) => toDashboardTask(t, now, ownDay)),
    [tasks, now, ownDay],
  );
  const spilloverTasks = useMemo(
    () => visibleSpillover.map((t) => toDashboardTask(t, now, prevDay)),
    [visibleSpillover, now, prevDay],
  );
  const progress = useMemo(() => calculateDayProgress(tasks), [tasks]);
  const remainingMinutes = useMemo(
    () => computeRemainingMinutes([...dashboardTasks, ...spilloverTasks], now, bounds),
    [dashboardTasks, spilloverTasks, now, bounds],
  );
  const conflictIds = useMemo(
    () =>
      new Set(
        detectScheduleConflicts([...tasks, ...visibleSpillover], now).flatMap((c) => [
          c.firstTaskId,
          c.secondTaskId,
        ]),
      ),
    [tasks, visibleSpillover, now],
  );
  const taskTitles = useMemo(() => new Map(tasks.map((t) => [t.id, t.title])), [tasks]);
  const rescheduling =
    [...dashboardTasks, ...spilloverTasks].find((t) => t.id === reschedulingId) ?? null;
  const busy = pendingTaskId !== null || isReplanning;
  const isToday = viewState === "today";

  /** Replaces one task with what the server persisted (whichever list holds it), snapshotting
   *  the layout first so the timeline can animate the reflow. */
  function replaceTask(updated: Task) {
    captureLayout();
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    setSpillover((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }

  async function handleStatusChange(
    taskId: string,
    status: Extract<TaskStatus, "completed" | "skipped">,
  ) {
    if (busy) return; // one mutation at a time is plenty for a single-user dashboard
    setPendingTaskId(taskId);
    try {
      const result = await updateTaskStatusAction({ taskId, status });
      if (!result.ok) {
        toast({ title: "Couldn't update task", description: result.error.message, tone: "error" });
        return;
      }
      replaceTask(result.data);
      toast({
        title: status === "completed" ? "Marked complete" : "Skipped",
        description: result.data.title,
        tone: status === "completed" ? "success" : "neutral",
      });
    } catch {
      toast({
        title: "Couldn't update task",
        description: "Check your connection and try again.",
        tone: "error",
      });
    } finally {
      setPendingTaskId(null);
    }
  }

  function handleCreated(task: Task, planningDate: string) {
    if (planningDate === localDate) {
      captureLayout();
      setTasks((prev) => [...prev, task]);
      setDayExists(true);
      toast({ title: "Task added", description: task.title, tone: "success" });
    } else {
      // Planned for a different day: it belongs to that day's plan, not this one's timeline.
      toast({
        title: `Added for ${formatPlanningDate(planningDate)}`,
        description: task.title,
        tone: "success",
      });
    }
  }

  function handleRescheduled(task: Task) {
    replaceTask(task);
    toast({ title: "Rescheduled", description: task.title, tone: "success" });
  }

  /** The AI dialog itself owns confirmation (Apply) and the success toast; this only merges
   *  the re-read tasks it returns, the same way `handleReplan` merges apply_replan's. */
  function handleAiApplied(outcome: { tasks: Task[] }) {
    captureLayout();
    setTasks(outcome.tasks);
  }

  async function handleReplan() {
    if (busy) return;
    setIsReplanning(true);
    try {
      // Only a DATE is sent for a future day; today needs no argument (resolved server-side).
      const result = await replanRemainingDayAction(
        isToday ? undefined : { planningDate: localDate },
      );
      if (!result.ok) {
        toast({ title: "Couldn't replan", description: result.error.message, tone: "error" });
        return;
      }
      const { tasks: next, changedCount, revisionNumber, unscheduled, conflicts } = result.data;
      captureLayout();
      setTasks(next);

      const notes: string[] = [];
      if (unscheduled.length > 0) {
        notes.push(
          `${unscheduled.length} ${unscheduled.length === 1 ? "task" : "tasks"} didn't fit.`,
        );
      }
      if (conflicts.length > 0) {
        notes.push(
          `${conflicts.length} ${conflicts.length === 1 ? "overlap needs" : "overlaps need"} your attention.`,
        );
      }
      if (changedCount === 0) {
        toast({
          title: "Nothing to change",
          description: [
            isToday ? "Your schedule is already up to date." : "This day is already planned.",
            ...notes,
          ].join(" "),
          tone: "neutral",
        });
      } else {
        toast({
          title: `Rescheduled ${changedCount} ${changedCount === 1 ? "task" : "tasks"}`,
          description: [`Saved as revision ${revisionNumber}.`, ...notes].join(" "),
          tone: "success",
        });
      }
    } catch {
      toast({
        title: "Couldn't replan",
        description: "Check your connection and try again.",
        tone: "error",
      });
    } finally {
      setIsReplanning(false);
    }
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
    } catch {
      toast({
        title: "Couldn't save briefing",
        description: "Check your connection and try again.",
        tone: "error",
      });
    } finally {
      setIsSavingBriefing(false);
    }
  }

  const timeline = (
    <section
      data-animate="section"
      aria-labelledby="timeline-heading"
      className="order-last lg:order-1"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="timeline-heading" className="text-sm font-semibold">
          {isToday ? "Today’s timeline" : `${formatPlanningDate(localDate)} timeline`}
        </h2>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void handleReplan()}
            disabled={busy || !dayExists}
          >
            <CalendarClock aria-hidden className="size-4" />
            {isReplanning ? "Replanning…" : isToday ? "Replan remaining day" : "Replan this day"}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
            <Plus aria-hidden className="size-4" />
            Add task
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setAiMode("ask");
              setAiOpen(true);
            }}
            disabled={!dayExists}
          >
            <Sparkles aria-hidden className="size-4" />
            {initialPendingAiProposal ? "Review AI plan" : "Ask AI"}
          </Button>
        </div>
      </div>
      <TodayTimeline
        handleRef={timelineRef}
        tasks={dashboardTasks}
        spillover={spilloverTasks}
        spilloverLabel={`From ${formatPlanningDate(prevDay.localDate)}`}
        showNow={isToday}
        timezone={timezone}
        now={now}
        conflictIds={conflictIds}
        pendingTaskId={pendingTaskId}
        onComplete={(id) => void handleStatusChange(id, "completed")}
        onSkip={(id) => void handleStatusChange(id, "skipped")}
        onReschedule={setReschedulingId}
      />
    </section>
  );

  return (
    <div ref={scope}>
      <DayNav localDate={localDate} todayLocal={todayLocal} />
      <DashboardHeader
        now={now}
        timezone={timezone}
        viewState={viewState}
        localDate={localDate}
        progress={progress}
        remainingMinutes={remainingMinutes}
      />

      {/*
        Mobile/tablet: a single flex column, briefing above timeline (`order-first`).
        Desktop (lg+): a two-column grid — timeline as the main column, briefing as a
        sticky side rail. Source order stays timeline-then-briefing at every width (the
        timeline is the primary content), only the visual `order` changes. A future day has no
        briefing (briefings belong to today), so its timeline takes the full width.
      */}
      {isToday ? (
        <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[1fr_20rem] lg:items-start xl:grid-cols-[1fr_22rem] xl:gap-8">
          {timeline}
          <div className="order-first lg:sticky lg:top-6 lg:order-2">
            <BriefingPanel
              initialText={briefingText}
              isSaving={isSavingBriefing}
              onSave={handleSaveBriefing}
              onPlan={() => {
                setAiMode("briefing");
                setAiOpen(true);
              }}
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-6">{timeline}</div>
      )}

      {/* Only today can be reviewed; a future day has nothing to wrap up yet. */}
      {isToday ? <EodPanel initialView={initialEodReport} dayExists={dayExists} /> : null}

      <AddTaskDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        now={now}
        viewDate={localDate}
        viewTimezone={timezone}
        profileTimezone={profileTimezone}
        todayLocal={todayLocal}
        onCreated={handleCreated}
      />
      {rescheduling ? (
        <RescheduleDialog
          key={rescheduling.id}
          task={rescheduling}
          now={now}
          onClose={() => setReschedulingId(null)}
          onRescheduled={handleRescheduled}
        />
      ) : null}
      <AiPlanDialog
        open={aiOpen}
        onOpenChange={setAiOpen}
        planningDate={localDate}
        mode={aiMode}
        taskTitles={taskTitles}
        timezone={timezone}
        resumedProposal={initialPendingAiProposal}
        onApplied={handleAiApplied}
      />
    </div>
  );
}
