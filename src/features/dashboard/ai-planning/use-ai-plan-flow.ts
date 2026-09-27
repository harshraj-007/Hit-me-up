"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  startVoiceRecognition,
  voiceCaptureError,
  type VoiceRecognitionSession,
} from "@/lib/voice/speech-recognition";
import type { ProposalView } from "./proposal-view";
import { proposalViewFromGenerated } from "./proposal-view";
import {
  confirmAiProposalAction,
  discardAiProposalAction,
  generateAiProposalAction,
} from "./actions";
import { initialVoicePlanStateFor, reduceVoicePlan, type VoicePlanState } from "./flow-state";

export interface UseAiPlanFlowOptions {
  planningDate: string;
  /** A proposal the server already found pending for this day (Phase 5.5 resume) — the panel
   *  opens straight into its review, with no AI call. Only read once, on mount: this hook does
   *  not react to it changing later. */
  resumedProposal?: ProposalView | null;
}

/**
 * Drives the pure reducer in `flow-state.ts` with real effects: the browser's speech engine,
 * and the Server Actions. This hook is intentionally thin and untested directly (this codebase
 * doesn't unit-test React hooks — see `useNow`/`useEntrance`); every decision it makes ("is
 * this stale", "is this the right transition", "is this proposal even confirmable") is
 * delegated to `reduceVoicePlan`, which is exhaustively tested on its own. Nothing here calls
 * `confirmAiProposalAction` except `confirm()`, which only the user pressing "Apply" ever
 * invokes, and nothing auto-applies a resumed proposal — it starts in `proposal_ready`, the
 * exact same review-and-wait state a fresh generation reaches, never past it.
 */
export function useAiPlanFlow({ planningDate, resumedProposal }: UseAiPlanFlowOptions) {
  const [state, dispatch] = useReducer(
    reduceVoicePlan,
    resumedProposal ?? null,
    initialVoicePlanStateFor,
  );
  const sessionRef = useRef<VoiceRecognitionSession | null>(null);
  const epochRef = useRef(0);

  const stopSession = useCallback(() => {
    sessionRef.current?.cancel();
    sessionRef.current = null;
  }, []);

  // Leaving the panel (unmount) must not leave a microphone session running.
  useEffect(() => stopSession, [stopSession]);

  const startTyping = useCallback(() => dispatch({ type: "start_typing" }), []);

  const startRecording = useCallback(() => {
    stopSession();
    const epoch = ++epochRef.current;
    dispatch({ type: "start_recording", epoch });
    sessionRef.current = startVoiceRecognition({
      onTranscriptChange(transcript) {
        dispatch({ type: "transcript_progress", epoch, transcript });
      },
      onEnd(transcript) {
        sessionRef.current = null;
        dispatch({ type: "recognition_ended", epoch, transcript });
      },
      onError(error) {
        sessionRef.current = null;
        dispatch({ type: "recognition_error", epoch, error });
      },
    });
  }, [stopSession]);

  const stopRecording = useCallback(() => {
    const epoch = epochRef.current;
    sessionRef.current?.stop();
    dispatch({ type: "stop_recording", epoch });
  }, []);

  const editText = useCallback((text: string) => dispatch({ type: "edit_text", text }), []);

  /** A pending, persisted proposal the user is walking away from without confirming it
   *  (Cancel from `proposal_ready`, or leaving the panel with one still showing) is explicitly
   *  discarded server-side — fire-and-forget: the UI has already moved on, and worst case (the
   *  request is lost) it simply gets superseded the next time a proposal is generated for this
   *  day, since at most one pending proposal per day is enforced regardless (see the
   *  migration). Never awaited, so Cancel never blocks on the network. */
  const discardIfPending = useCallback(() => {
    if (state.status === "proposal_ready") {
      void discardAiProposalAction({ proposalId: state.view.proposalId });
    }
  }, [state]);

  const cancel = useCallback(() => {
    discardIfPending();
    stopSession();
    epochRef.current += 1;
    dispatch({ type: "cancel" });
  }, [discardIfPending, stopSession]);

  const reset = useCallback(() => {
    discardIfPending();
    stopSession();
    epochRef.current += 1;
    dispatch({ type: "reset" });
  }, [discardIfPending, stopSession]);

  const submit = useCallback(async () => {
    if (state.status !== "transcript_review") return;
    const epoch = state.epoch;
    const { source, text } = state;
    dispatch({ type: "submit", epoch });
    const result = await generateAiProposalAction({
      id: crypto.randomUUID(),
      source,
      text,
      planningDate,
    });
    if (!result.ok) {
      dispatch({ type: "proposal_failed", epoch, message: result.error.message });
      return;
    }
    dispatch({ type: "proposal_ready", epoch, view: proposalViewFromGenerated(result.data) });
  }, [state, planningDate]);

  const confirm = useCallback(async () => {
    if (state.status !== "proposal_ready") return;
    const epoch = state.epoch;
    const { view } = state;
    // Belt and suspenders: the UI already hides Apply for anything not valid, or stale, and
    // the reducer's own "confirm" transition already refuses both — this is a third, redundant
    // guard against ever making the network call at all in either case.
    if (view.status !== "valid" || view.isStale) return;
    dispatch({ type: "confirm", epoch });
    const outcome = await confirmAiProposalAction({ proposalId: view.proposalId });
    if (!outcome.ok) {
      dispatch({ type: "confirm_failed", epoch, message: outcome.error.message });
      return;
    }
    dispatch({ type: "confirmed", epoch, outcome: outcome.data });
  }, [state]);

  return {
    state: state as VoicePlanState,
    startTyping,
    startRecording,
    stopRecording,
    editText,
    submit,
    confirm,
    cancel,
    reset,
  };
}

// Re-exported so a caller never needs to reach into ./speech-recognition directly just to show
// a friendly "recording failed" message for an error this hook already surfaced via `state`.
export { voiceCaptureError };
