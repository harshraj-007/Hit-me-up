"use client";

import { useEffect, useMemo } from "react";
import { CalendarPlus, Mic, Square, Type, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast-provider";
import { isVoiceCaptureSupported } from "@/lib/voice/speech-recognition";
import { formatClock, formatRange } from "@/lib/format/time";
import { useEntrance } from "@/lib/motion";
import { useAiPlanFlow, type AiPlanMode } from "./use-ai-plan-flow";
import type { ProposalView } from "./proposal-view";
import type { ConfirmAiProposalOutcome } from "@/server/services/ai-confirmation";

export interface AiPlanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planningDate: string;
  /** `briefing` is "Plan my day": new tasks from the saved briefing (loaded by the server).
   *  `ask` is the ordinary schedule-change request. One dialog, one review, one Apply either way. */
  mode: AiPlanMode;
  /** Titles of the day's own tasks by id, so a move reads "Gym → 8:00 PM", not an alias. */
  taskTitles: ReadonlyMap<string, string>;
  /** The day's own frozen timezone — every proposed time is shown in it, never the browser's. */
  timezone: string;
  /** A proposal the server already found pending for this day (Phase 5.5 resume) — the dialog
   *  opens straight into reviewing it, with no AI call. Null when there is none. */
  resumedProposal: ProposalView | null;
  onApplied: (outcome: ConfirmAiProposalOutcome) => void;
}

const MAX_TRANSCRIPT_LENGTH = 1000;

/**
 * The one entry point for both typed and voice AI planning requests, and for resuming a
 * proposal the server generated earlier (Phase 5.5). Voice is purely an input mode: recording
 * only ever produces a transcript for the SAME review step typed text goes through, and
 * nothing past that point knows or cares which mode produced the text, or whether the review
 * screen it's looking at came from a fresh generation or a resumed one — see
 * `use-ai-plan-flow.ts` and `proposal-view.ts`. Nothing here ever calls the confirm action
 * except the explicit Apply button, and Apply itself is disabled unless the validator reported
 * `status: "valid"` AND (for a resumed proposal) the schedule hasn't changed since.
 */
export function AiPlanDialog({
  open,
  onOpenChange,
  planningDate,
  mode,
  taskTitles,
  timezone,
  resumedProposal,
  onApplied,
}: AiPlanDialogProps) {
  const { toast } = useToast();
  const flow = useAiPlanFlow({ planningDate, mode, resumedProposal });
  const { state } = flow;
  const voiceSupported = useMemo(() => isVoiceCaptureSupported(), []);

  // Leaving the dialog mid-flow (including while a request is in flight) must not leave a
  // recording session running, and reopening it starts clean rather than resuming whatever was
  // on screen last time. `cancel()` bumps the flow's epoch, so a generate/confirm response that
  // arrives after this is simply dropped by the reducer (see flow-state.ts) — it can never
  // resurrect a proposal, let alone apply one, once the user has left.
  useEffect(() => {
    if (!open) flow.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only `open` should retrigger this
  }, [open]);

  useEffect(() => {
    if (state.status === "applied") {
      onApplied(state.outcome);
      toast({
        title: "Plan applied",
        description: `${state.outcome.tasks.length} task${state.outcome.tasks.length === 1 ? "" : "s"} on this day.`,
        tone: "success",
      });
      onOpenChange(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once per transition into "applied"
  }, [state.status]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={mode === "briefing" ? "Plan my day" : "Ask AI"}
      description={
        mode === "briefing"
          ? "Turn your saved briefing into a proposed schedule. Nothing is added until you apply it."
          : "Describe a schedule change, by typing or speaking."
      }
    >
      <div className="flex flex-col gap-4">
        {state.status === "idle" && mode === "briefing" ? (
          <div className="flex flex-col gap-3">
            <Button onClick={() => void flow.planFromBriefing()}>
              <CalendarPlus aria-hidden className="size-4" />
              Plan from my briefing
            </Button>
            <p className="text-foreground-muted text-xs">
              Want to steer it? Add a note first — type it or say it — then it plans from your
              briefing and your note.
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={flow.startTyping} className="flex-1">
                <Type aria-hidden className="size-4" />
                Add a note
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={flow.startRecording}
                disabled={!voiceSupported}
                title={voiceSupported ? undefined : "Voice input isn't supported in this browser."}
                className="flex-1"
              >
                <Mic aria-hidden className="size-4" />
                Speak a note
              </Button>
            </div>
          </div>
        ) : null}

        {state.status === "idle" && mode === "ask" ? (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={flow.startTyping} className="flex-1">
              <Type aria-hidden className="size-4" />
              Type a request
            </Button>
            <Button
              variant="secondary"
              onClick={flow.startRecording}
              disabled={!voiceSupported}
              title={voiceSupported ? undefined : "Voice input isn't supported in this browser."}
              className="flex-1"
            >
              <Mic aria-hidden className="size-4" />
              Speak a request
            </Button>
          </div>
        ) : null}

        {state.status === "recording" ? (
          <div className="flex flex-col gap-3">
            <div className="text-foreground-muted flex items-center gap-2 text-sm">
              <span
                aria-hidden
                className="size-2.5 animate-pulse rounded-full bg-danger motion-reduce:animate-none"
              />
              Recording…
            </div>
            <p className="text-foreground-muted min-h-16 rounded-md border border-border bg-surface p-3 text-sm">
              {state.transcript || "Say what you'd like to change…"}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={flow.cancel}>
                Cancel
              </Button>
              <Button size="sm" onClick={flow.stopRecording}>
                <Square aria-hidden className="size-3.5" />
                Stop
              </Button>
            </div>
          </div>
        ) : null}

        {state.status === "transcribing" ? (
          <p className="text-foreground-muted text-sm" role="status">
            Finishing up…
          </p>
        ) : null}

        {state.status === "transcript_review" ? (
          <TranscriptReview
            text={state.text}
            source={state.source}
            briefingMode={mode === "briefing"}
            onChange={flow.editText}
            onCancel={flow.cancel}
            onSubmit={() => void flow.submit()}
          />
        ) : null}

        {state.status === "generating" ? (
          <p className="text-foreground-muted text-sm" role="status">
            Thinking…
          </p>
        ) : null}

        {state.status === "proposal_ready" ? (
          <ProposalReview
            view={state.view}
            taskTitles={taskTitles}
            timezone={timezone}
            onCancel={flow.cancel}
            onApply={() => void flow.confirm()}
          />
        ) : null}

        {state.status === "confirming" ? (
          <p className="text-foreground-muted text-sm" role="status">
            Applying…
          </p>
        ) : null}

        {state.status === "error" ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-danger" role="alert">
              {state.message}
            </p>
            <div className="flex justify-end">
              <Button size="sm" variant="secondary" onClick={flow.reset}>
                Try again
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function TranscriptReview({
  text,
  source,
  briefingMode,
  onChange,
  onCancel,
  onSubmit,
}: {
  text: string;
  source: "typed" | "voice";
  briefingMode: boolean;
  onChange: (text: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {source === "voice"
          ? "Transcript — edit if needed"
          : briefingMode
            ? "A note for the planner"
            : "What would you like to change?"}
        <textarea
          autoFocus
          rows={4}
          maxLength={MAX_TRANSCRIPT_LENGTH}
          value={text}
          onChange={(event) => onChange(event.target.value)}
          placeholder={
            briefingMode
              ? "e.g. Keep the evening free, and do the hardest thing first."
              : "e.g. Move gym to after 8pm, and unschedule my reading block."
          }
          className="rounded-md border border-border bg-surface p-3 text-sm font-normal text-foreground focus:ring-2 focus:ring-accent focus:outline-none"
        />
      </label>
      <div className="flex items-center justify-between">
        <span className="text-foreground-muted text-xs">
          {text.length}/{MAX_TRANSCRIPT_LENGTH}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={onSubmit} disabled={text.trim() === ""}>
            Generate plan
          </Button>
        </div>
      </div>
    </div>
  );
}

const PRIORITY_LABEL = { high: "High", medium: "Medium", low: "Low" } as const;
const KIND_LABEL = {
  flexible: "Flexible",
  deadline: "Deadline",
  optional: "Optional",
  fixed: "Fixed",
} as const;

/**
 * The review answers four questions in order: what did the AI propose (its own words), which
 * tasks are NEW, which existing tasks would MOVE, and exactly what Apply will do. Apply stays
 * explicit and all-or-nothing: it is enabled only for a fully valid, current proposal.
 */
function ProposalReview({
  view,
  taskTitles,
  timezone,
  onCancel,
  onApply,
}: {
  view: ProposalView;
  taskTitles: ReadonlyMap<string, string>;
  timezone: string;
  onCancel: () => void;
  onApply: () => void;
}) {
  // Stale is checked first and independently of `status`: a resumed proposal can be `valid`
  // AND stale at once (it was valid when generated; the schedule just moved on since).
  const canApply = !view.isStale && view.status === "valid";
  const scope = useEntrance<HTMLDivElement>({ selector: "[data-animate='row']", stagger: 0.04 });

  const created = view.accepted.filter((c) => c.kind === "create" && c.create);
  const changed = view.accepted.filter((c) => c.kind !== "create");
  const moves = changed.filter((c) => c.kind === "move").length;
  const unschedules = changed.length - moves;
  const summary = [
    created.length > 0 ? `${created.length} new task${created.length === 1 ? "" : "s"}` : null,
    moves > 0 ? `${moves} move${moves === 1 ? "" : "s"}` : null,
    unschedules > 0 ? `${unschedules} unscheduled` : null,
  ].filter(Boolean);

  return (
    <div ref={scope} className="flex flex-col gap-3">
      {view.isStale ? (
        <p className="rounded-md bg-surface p-2.5 text-sm text-status-late" role="status">
          This plan is outdated because your schedule changed. Generate a new plan.
        </p>
      ) : null}

      <p className="text-sm text-foreground">{view.understood}</p>

      {created.length > 0 ? (
        <section aria-label="New tasks" className="flex flex-col gap-1.5">
          <h3 className="text-foreground-muted text-xs font-semibold tracking-wide uppercase">
            New tasks
          </h3>
          <ul className="flex flex-col gap-1.5">
            {created.map((change) => {
              const task = change.create!;
              return (
                <li
                  key={change.ref}
                  data-animate="row"
                  data-testid="proposed-new-task"
                  className="rounded-md border border-l-2 border-border border-l-accent bg-surface px-3 py-2 text-sm"
                >
                  <span className="font-medium">{task.title}</span>
                  <span className="text-foreground-muted block text-xs">
                    {formatRange(task.start, task.end, timezone)} · {task.durationMinutes} min ·{" "}
                    {PRIORITY_LABEL[task.priority]} priority · {KIND_LABEL[task.taskKind]}
                  </span>
                  {change.reason ? (
                    <span className="text-foreground-muted block text-xs">{change.reason}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {changed.length > 0 ? (
        <section aria-label="Changes to existing tasks" className="flex flex-col gap-1.5">
          <h3 className="text-foreground-muted text-xs font-semibold tracking-wide uppercase">
            Existing tasks
          </h3>
          <ul className="flex flex-col gap-1.5">
            {changed.map((change) => (
              <li
                key={change.ref}
                data-animate="row"
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
              >
                <span className="font-medium">
                  {(change.taskId && taskTitles.get(change.taskId)) || "A task on this day"}
                </span>
                <span className="block text-xs">
                  {change.kind === "move" && change.newStart ? (
                    <>
                      Move to{" "}
                      <span className="font-medium">{formatClock(change.newStart, timezone)}</span>
                    </>
                  ) : (
                    <>Unschedule</>
                  )}
                </span>
                {change.reason ? (
                  <span className="text-foreground-muted block text-xs">{change.reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.rejectedMessages.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {view.rejectedMessages.map((message, index) => (
            <li key={index} className="text-foreground-muted flex items-start gap-1.5 text-xs">
              <X aria-hidden className="mt-0.5 size-3 shrink-0 text-danger" />
              {message}
            </li>
          ))}
        </ul>
      ) : null}

      {view.conflictCount > 0 ? (
        <p className="text-xs text-status-late">
          {view.conflictCount === 1
            ? "One overlap would remain."
            : `${view.conflictCount} overlaps would remain.`}
        </p>
      ) : null}

      {view.unresolved.length > 0 ? (
        <div className="text-foreground-muted rounded-md bg-surface p-2.5 text-xs">
          <p className="mb-1 font-medium">Not applied:</p>
          <ul className="list-inside list-disc">
            {view.unresolved.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {!canApply && view.accepted.length === 0 && !view.isStale ? (
        <p className="text-foreground-muted text-sm">Nothing here can be applied.</p>
      ) : null}

      {canApply && summary.length > 0 ? (
        <p className="text-foreground-muted text-xs" data-testid="apply-summary">
          Apply will add or change exactly this, all together: {summary.join(", ")}.
        </p>
      ) : null}
      {!canApply && !view.isStale && view.accepted.length > 0 ? (
        <p className="text-foreground-muted text-xs">
          Something in this plan couldn&rsquo;t be accepted, so nothing will be applied. Cancel and
          try again.
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {view.isStale ? "Dismiss" : "Cancel"}
        </Button>
        <Button size="sm" onClick={onApply} disabled={!canApply}>
          Apply
        </Button>
      </div>
    </div>
  );
}
