/**
 * A thin wrapper around the browser's built-in speech recognition (the "Web Speech API";
 * `SpeechRecognition`, or `webkitSpeechRecognition` in Chromium). This is the transcription
 * mechanism Phase 5.4 uses — see PROJECT_ARCHITECTURE.md for why, in short: it needs no server
 * route, no new dependency, no provider credentials of any kind (there is nothing to keep
 * secret, and nothing for the browser bundle to leak), and audio never becomes a value this
 * codebase holds, sends, or stores — the browser transcribes it internally and this module only
 * ever sees the resulting text. That also means several concerns that a MediaRecorder-based
 * pipeline would have to handle explicitly — releasing microphone `MediaStream` tracks, cleaning
 * up an audio Blob/object URL — do not apply here; there is no `MediaStream` or `Blob` in this
 * module at all. What genuinely does need managing is the recognition session's own lifecycle:
 * exactly one active session, a `cancel()` that reliably silences a session's own trailing
 * events (the browser may still fire one after `stop()`/`abort()`), and typed, non-leaky errors.
 *
 * `SpeechRecognition` is not in TypeScript's standard DOM lib, so the shapes below are a
 * deliberately minimal ambient description of the subset this module uses — not a general
 * polyfill or typing package.
 */

export type VoiceCaptureErrorReason =
  | "microphone_unsupported"
  | "microphone_permission_denied"
  | "recording_failed"
  | "empty_recording";

export interface VoiceCaptureError {
  reason: VoiceCaptureErrorReason;
  /** Fixed, user-safe text — never a raw browser/engine error string. */
  message: string;
}

const ERROR_MESSAGES: Record<VoiceCaptureErrorReason, string> = {
  microphone_unsupported: "Voice input isn't supported in this browser.",
  microphone_permission_denied:
    "Microphone access was denied. Allow microphone access and try again.",
  recording_failed: "Recording failed. Try again.",
  empty_recording: "No speech was heard. Try again.",
};

export function voiceCaptureError(reason: VoiceCaptureErrorReason): VoiceCaptureError {
  return { reason, message: ERROR_MESSAGES[reason] };
}

export interface VoiceRecognitionHandlers {
  /** Fires as the engine produces text; `isFinal` marks a segment the engine won't revise. */
  onTranscriptChange(transcript: string, isFinal: boolean): void;
  /** Fires once, after the session ends normally with at least one final word heard. */
  onEnd(finalTranscript: string): void;
  /** Fires once, instead of `onEnd`, for `microphone_permission_denied`, `recording_failed`,
   *  or `empty_recording` (a session that ended having heard nothing). */
  onError(error: VoiceCaptureError): void;
}

export interface VoiceRecognitionSession {
  /** Asks the engine to finalize and stop; `onEnd`/`onError` still fires once, asynchronously. */
  stop(): void;
  /** Stops immediately and permanently silences this session: no handler fires again, even for
   *  an event the browser was already about to deliver. */
  cancel(): void;
}

/** The minimal shape this module reads from `SpeechRecognitionEvent`/`SpeechRecognitionResult`. */
interface MinimalRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
interface MinimalRecognitionErrorEvent {
  error: string;
}
interface MinimalSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: MinimalRecognitionEvent) => void) | null;
  onerror: ((event: MinimalRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => MinimalSpeechRecognition;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  // `globalThis`, not `window`: in a real browser they're the same object, and this also lets
  // a test stub the constructor without a full `window`/DOM environment.
  const g = globalThis as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition;
}

/** Whether this browser exposes a usable engine at all — check before showing a voice button. */
export function isVoiceCaptureSupported(): boolean {
  return getSpeechRecognitionCtor() !== undefined;
}

/** A `SpeechRecognitionErrorEvent.error` that means "no permission", vs. everything else, which
 *  is treated as a generic recording failure — the browser's own vocabulary here is small and
 *  fairly stable, but this module never forwards it verbatim regardless. */
const PERMISSION_DENIED_CODES = new Set([
  "not-allowed",
  "permission-denied",
  "service-not-allowed",
]);
/** Heard nothing before the engine gave up — not a failure, just an empty result. */
const NO_SPEECH_CODES = new Set(["no-speech"]);
/** The user (or a caller) stopped it on purpose; never surfaced as an error. */
const ABORTED_CODES = new Set(["aborted"]);

/**
 * Starts exactly one recognition session and returns a handle to control it. If the browser has
 * no engine at all, `handlers.onError` fires synchronously with `microphone_unsupported` and the
 * returned handle is an inert no-op — callers don't need to branch on support twice.
 */
export function startVoiceRecognition(handlers: VoiceRecognitionHandlers): VoiceRecognitionSession {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    handlers.onError(voiceCaptureError("microphone_unsupported"));
    return { stop() {}, cancel() {} };
  }

  let cancelled = false;
  let ended = false;
  let finalTranscript = "";
  let interimTranscript = "";
  let sawAnyResult = false;

  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = typeof navigator !== "undefined" ? navigator.language : "en-US";

  function emitTranscript() {
    if (cancelled) return;
    handlers.onTranscriptChange(
      (finalTranscript + interimTranscript).trim(),
      interimTranscript === "",
    );
  }

  recognition.onresult = (event) => {
    if (cancelled) return;
    interimTranscript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result) continue;
      const text = result[0]?.transcript ?? "";
      if (!text) continue;
      sawAnyResult = true;
      if (result.isFinal) finalTranscript += (finalTranscript ? " " : "") + text.trim();
      else interimTranscript += text;
    }
    emitTranscript();
  };

  recognition.onerror = (event) => {
    if (cancelled || ended) return;
    if (ABORTED_CODES.has(event.error)) return; // handled by cancel()/stop(), not an error
    ended = true;
    if (PERMISSION_DENIED_CODES.has(event.error)) {
      handlers.onError(voiceCaptureError("microphone_permission_denied"));
    } else if (NO_SPEECH_CODES.has(event.error)) {
      handlers.onError(voiceCaptureError("empty_recording"));
    } else {
      handlers.onError(voiceCaptureError("recording_failed"));
    }
  };

  recognition.onend = () => {
    if (cancelled || ended) return;
    ended = true;
    const text = finalTranscript.trim();
    if (!sawAnyResult || !text) handlers.onError(voiceCaptureError("empty_recording"));
    else handlers.onEnd(text);
  };

  try {
    recognition.start();
  } catch {
    // Most commonly: a session was already active for this engine instance/tab.
    cancelled = true;
    handlers.onError(voiceCaptureError("recording_failed"));
    return { stop() {}, cancel() {} };
  }

  return {
    stop() {
      if (cancelled || ended) return;
      recognition.stop();
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      ended = true;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.abort();
    },
  };
}
