"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  startVoiceRecognition,
  voiceCaptureError,
  type VoiceRecognitionSession,
} from "@/lib/voice/speech-recognition";
import { confirmAiProposalAction, generateAiProposalAction } from "./actions";
import { initialVoicePlanState, reduceVoicePlan, type VoicePlanState } from "./flow-state";

export interface UseAiPlanFlowOptions {
  planningDate: string;
}

/**
 * Drives the pure reducer in `flow-state.ts` with real effects: the browser's speech engine,
 * and the two Server Actions. This hook is intentionally thin and untested directly (this
 * codebase doesn't unit-test React hooks — see `useNow`/`useEntrance`); every decision it makes
 * ("is this stale", "is this the right transition") is delegated to `reduceVoicePlan`, which
 * is exhaustively tested on its own. Nothing here calls `confirmAiProposalAction` except
 * `confirm()`, which only the user pressing "Apply" ever invokes.
 */
export function useAiPlanFlow({ planningDate }: UseAiPlanFlowOptions) {
  const [state, dispatch] = useReducer(reduceVoicePlan, initialVoicePlanState);
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

  const cancel = useCallback(() => {
    stopSession();
    epochRef.current += 1;
    dispatch({ type: "cancel" });
  }, [stopSession]);

  const reset = useCallback(() => {
    stopSession();
    epochRef.current += 1;
    dispatch({ type: "reset" });
  }, [stopSession]);

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
    dispatch({ type: "proposal_ready", epoch, result: result.data });
  }, [state, planningDate]);

  const confirm = useCallback(async () => {
    if (state.status !== "proposal_ready") return;
    const epoch = state.epoch;
    const { result } = state;
    if (result.validation.status !== "valid") return; // belt and suspenders: the UI already hides Apply
    dispatch({ type: "confirm", epoch });
    const outcome = await confirmAiProposalAction({
      planningDate,
      baseRevision: result.validation.baseRevision,
      changes: result.validation.accepted.map((c) =>
        c.kind === "move"
          ? { ref: c.ref, taskId: c.taskId, type: "move", newStart: c.newStart.toISOString() }
          : { ref: c.ref, taskId: c.taskId, type: "unschedule" },
      ),
    });
    if (!outcome.ok) {
      dispatch({ type: "confirm_failed", epoch, message: outcome.error.message });
      return;
    }
    dispatch({ type: "confirmed", epoch, outcome: outcome.data });
  }, [state, planningDate]);

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
