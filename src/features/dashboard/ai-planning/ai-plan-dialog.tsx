"use client";

import { useEffect, useMemo } from "react";
import { Mic, Square, Type, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast-provider";
import { isVoiceCaptureSupported } from "@/lib/voice/speech-recognition";
import { formatClock } from "@/lib/format/time";
import { useAiPlanFlow } from "./use-ai-plan-flow";
import type { ConfirmAiProposalOutcome } from "@/server/services/ai-confirmation";
import type { AiProposalResult } from "@/server/services/ai-planning";

export interface AiPlanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planningDate: string;
  /** The day's own frozen timezone — every proposed time is shown in it, never the browser's. */
  timezone: string;
  onApplied: (outcome: ConfirmAiProposalOutcome) => void;
}

const MAX_TRANSCRIPT_LENGTH = 1000;

/**
 * The one entry point for both typed and voice AI planning requests. Voice is purely an input
 * mode: recording only ever produces a transcript for the SAME review step typed text goes
 * through, and nothing past that point knows or cares which mode produced the text — see
 * `use-ai-plan-flow.ts`, which sends it to the existing `generateAiProposal`/`confirmAiProposal`
 * pipeline unchanged. Nothing here ever calls the confirm action except the explicit Apply
 * button, and Apply itself is disabled unless the validator reported `status: "valid"`.
 */
export function AiPlanDialog({
  open,
  onOpenChange,
  planningDate,
  timezone,
  onApplied,
}: AiPlanDialogProps) {
  const { toast } = useToast();
  const flow = useAiPlanFlow({ planningDate });
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
      title="Ask AI"
      description="Describe a schedule change, by typing or speaking."
    >
      <div className="flex flex-col gap-4">
        {state.status === "idle" ? (
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
            result={state.result}
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
  onChange,
  onCancel,
  onSubmit,
}: {
  text: string;
  source: "typed" | "voice";
  onChange: (text: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {source === "voice" ? "Transcript — edit if needed" : "What would you like to change?"}
        <textarea
          autoFocus
          rows={4}
          maxLength={MAX_TRANSCRIPT_LENGTH}
          value={text}
          onChange={(event) => onChange(event.target.value)}
          placeholder="e.g. Move gym to after 8pm, and unschedule my reading block."
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

function ProposalReview({
  result,
  timezone,
  onCancel,
  onApply,
}: {
  result: AiProposalResult;
  timezone: string;
  onCancel: () => void;
  onApply: () => void;
}) {
  const { validation } = result;
  const canApply = validation.status === "valid";

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-foreground">{result.understood}</p>

      {validation.accepted.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {validation.accepted.map((change) => (
            <li
              key={change.taskId}
              className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
            >
              {change.kind === "move" ? (
                <>
                  Move to{" "}
                  <span className="font-medium">{formatClock(change.newStart, timezone)}</span>
                </>
              ) : (
                <>Unschedule</>
              )}
              {change.reason ? (
                <span className="text-foreground-muted block text-xs">{change.reason}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {validation.rejected.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {validation.rejected.map((rejection, index) => (
            <li key={index} className="text-foreground-muted flex items-start gap-1.5 text-xs">
              <X aria-hidden className="mt-0.5 size-3 shrink-0 text-danger" />
              {rejection.message}
            </li>
          ))}
        </ul>
      ) : null}

      {validation.conflictsAfter.length > 0 ? (
        <p className="text-xs text-status-late">
          {validation.conflictsAfter.length === 1
            ? "One overlap would remain."
            : `${validation.conflictsAfter.length} overlaps would remain.`}
        </p>
      ) : null}

      {result.unresolved.length > 0 ? (
        <div className="text-foreground-muted rounded-md bg-surface p-2.5 text-xs">
          <p className="mb-1 font-medium">Not applied:</p>
          <ul className="list-inside list-disc">
            {result.unresolved.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {!canApply && validation.accepted.length === 0 ? (
        <p className="text-foreground-muted text-sm">Nothing here can be applied.</p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={onApply} disabled={!canApply}>
          Apply
        </Button>
      </div>
    </div>
  );
}
