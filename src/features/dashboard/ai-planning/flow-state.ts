import type { VoiceCaptureError } from "@/lib/voice/speech-recognition";
import type { AiProposalResult } from "@/server/services/ai-planning";
import type { ConfirmAiProposalOutcome } from "@/server/services/ai-confirmation";

/**
 * The AI-plan panel's state machine, as a pure reducer — no React, no browser API, no network
 * call. The hook that drives the real UI (`use-ai-plan-flow.ts`) only dispatches events into
 * this; every transition, including where a stale async result gets dropped, is decided here
 * and is fully unit-testable without a DOM.
 *
 * `epoch` is what makes a stale result harmless: `startRecording`, `submitTranscript` and
 * `confirm` each begin a new epoch, and an event tagged with any other epoch is simply ignored
 * — so a transcription that finishes after the user already cancelled and started a new
 * recording, or a proposal that resolves after the user already left the panel, can never
 * clobber newer state. This mirrors the same "the newest request wins" rule
 * `src/server/ai/anthropic.ts` already enforces with its own AbortSignal, just on the client.
 */

export type PlanInputSource = "typed" | "voice";

export type VoicePlanState =
  | { status: "idle"; epoch: number }
  | { status: "recording"; epoch: number; transcript: string }
  | { status: "transcribing"; epoch: number; transcript: string }
  | { status: "transcript_review"; epoch: number; source: PlanInputSource; text: string }
  | { status: "generating"; epoch: number; source: PlanInputSource; text: string }
  | {
      status: "proposal_ready";
      epoch: number;
      source: PlanInputSource;
      text: string;
      result: AiProposalResult;
    }
  | {
      status: "confirming";
      epoch: number;
      source: PlanInputSource;
      text: string;
      result: AiProposalResult;
    }
  | { status: "applied"; epoch: number; outcome: ConfirmAiProposalOutcome }
  | { status: "error"; epoch: number; message: string; returnTo: "idle" | "transcript_review" };

export const initialVoicePlanState: VoicePlanState = { status: "idle", epoch: 0 };

export type VoicePlanEvent =
  | { type: "start_typing" }
  | { type: "start_recording"; epoch: number }
  | { type: "transcript_progress"; epoch: number; transcript: string }
  | { type: "stop_recording"; epoch: number }
  | { type: "recognition_ended"; epoch: number; transcript: string }
  | { type: "recognition_error"; epoch: number; error: VoiceCaptureError }
  | { type: "edit_text"; text: string }
  | { type: "submit"; epoch: number }
  | { type: "proposal_ready"; epoch: number; result: AiProposalResult }
  | { type: "proposal_failed"; epoch: number; message: string }
  | { type: "confirm"; epoch: number }
  | { type: "confirmed"; epoch: number; outcome: ConfirmAiProposalOutcome }
  | { type: "confirm_failed"; epoch: number; message: string }
  | { type: "cancel" }
  | { type: "reset" };

function isStale(state: VoicePlanState, epoch: number): boolean {
  return epoch !== state.epoch;
}

export function reduceVoicePlan(state: VoicePlanState, event: VoicePlanEvent): VoicePlanState {
  switch (event.type) {
    case "start_typing":
      return { status: "transcript_review", epoch: state.epoch, source: "typed", text: "" };

    case "start_recording":
      // Always accepted, even mid-flow: starting a new recording supersedes whatever came before.
      return { status: "recording", epoch: event.epoch, transcript: "" };

    case "transcript_progress":
      if (state.status !== "recording" || isStale(state, event.epoch)) return state;
      return { ...state, transcript: event.transcript };

    case "stop_recording":
      if (state.status !== "recording" || isStale(state, event.epoch)) return state;
      return { status: "transcribing", epoch: state.epoch, transcript: state.transcript };

    case "recognition_ended":
      if (state.status !== "transcribing" || isStale(state, event.epoch)) return state;
      return {
        status: "transcript_review",
        epoch: state.epoch,
        source: "voice",
        text: event.transcript,
      };

    case "recognition_error":
      if (
        (state.status !== "recording" && state.status !== "transcribing") ||
        isStale(state, event.epoch)
      ) {
        return state;
      }
      return {
        status: "error",
        epoch: state.epoch,
        message: event.error.message,
        returnTo: "idle",
      };

    case "edit_text":
      if (state.status !== "transcript_review") return state;
      return { ...state, text: event.text };

    case "submit":
      if (state.status !== "transcript_review" || isStale(state, event.epoch)) return state;
      if (state.text.trim() === "") return state;
      return { status: "generating", epoch: state.epoch, source: state.source, text: state.text };

    case "proposal_ready":
      if (state.status !== "generating" || isStale(state, event.epoch)) return state;
      return {
        status: "proposal_ready",
        epoch: state.epoch,
        source: state.source,
        text: state.text,
        result: event.result,
      };

    case "proposal_failed":
      if (state.status !== "generating" || isStale(state, event.epoch)) return state;
      return {
        status: "error",
        epoch: state.epoch,
        message: event.message,
        returnTo: "transcript_review",
      };

    case "confirm":
      // Same epoch as the proposal being confirmed (like `submit`, this continues the current
      // branch rather than starting a new one) — so confirming a proposal that's already been
      // superseded (the user cancelled, or a fresher proposal replaced it) is refused.
      if (state.status !== "proposal_ready" || isStale(state, event.epoch)) return state;
      return {
        status: "confirming",
        epoch: state.epoch,
        source: state.source,
        text: state.text,
        result: state.result,
      };

    case "confirmed":
      if (state.status !== "confirming" || isStale(state, event.epoch)) return state;
      return { status: "applied", epoch: state.epoch, outcome: event.outcome };

    case "confirm_failed":
      if (state.status !== "confirming" || isStale(state, event.epoch)) return state;
      return {
        status: "error",
        epoch: state.epoch,
        message: event.message,
        returnTo: "transcript_review",
      };

    case "cancel":
      // Bumping the epoch here (not just on the next start) means a callback from whatever was
      // in flight when cancel was pressed can never land, even if it arrives before anything
      // else bumps the epoch first.
      return { status: "idle", epoch: state.epoch + 1 };

    case "reset":
      return { status: "idle", epoch: state.epoch + 1 };

    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
