import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isVoiceCaptureSupported,
  startVoiceRecognition,
  voiceCaptureError,
} from "./speech-recognition";

/** A minimal, controllable fake of the browser's SpeechRecognition constructor. */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  static startThrows: unknown = null;
  continuous = false;
  interimResults = false;
  lang = "";
  started = false;
  stopped = false;
  aborted = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    if (FakeRecognition.startThrows) throw FakeRecognition.startThrows;
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  abort() {
    this.aborted = true;
  }

  /** Cumulative, like the real API: each call appends new results and reports only the
   *  newly-added index range via `resultIndex`, exactly as the browser does. */
  private cumulative: { transcript: string; isFinal: boolean }[] = [];
  result(segments: { transcript: string; isFinal: boolean }[]) {
    const resultIndex = this.cumulative.length;
    this.cumulative.push(...segments);
    this.onresult?.({
      resultIndex,
      results: this.cumulative.map((s) =>
        Object.assign([{ transcript: s.transcript }], { isFinal: s.isFinal }),
      ),
    });
  }
  error(code: string) {
    this.onerror?.({ error: code });
  }
  end() {
    this.onend?.();
  }
}

function handlers() {
  const transcripts: [string, boolean][] = [];
  const ends: string[] = [];
  const errors: unknown[] = [];
  return {
    transcripts,
    ends,
    errors,
    onTranscriptChange: (t: string, isFinal: boolean) => transcripts.push([t, isFinal]),
    onEnd: (t: string) => ends.push(t),
    onError: (e: unknown) => errors.push(e),
  };
}

beforeEach(() => {
  FakeRecognition.instances = [];
  FakeRecognition.startThrows = null;
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
  vi.stubGlobal("navigator", { language: "en-US" });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isVoiceCaptureSupported", () => {
  it("is true when the engine constructor exists", () => {
    expect(isVoiceCaptureSupported()).toBe(true);
  });
  it("is false with no engine at all", () => {
    vi.unstubAllGlobals();
    expect(isVoiceCaptureSupported()).toBe(false);
  });
  it("also recognizes the webkit-prefixed constructor", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    expect(isVoiceCaptureSupported()).toBe(true);
  });
});

describe("startVoiceRecognition — unsupported browser", () => {
  it("reports microphone_unsupported synchronously and returns an inert handle", () => {
    vi.unstubAllGlobals();
    const h = handlers();
    const session = startVoiceRecognition(h);
    expect(h.errors).toEqual([voiceCaptureError("microphone_unsupported")]);
    expect(() => session.stop()).not.toThrow();
    expect(() => session.cancel()).not.toThrow();
  });
});

describe("startVoiceRecognition — transcript flow", () => {
  it("starts with continuous + interim results enabled", () => {
    startVoiceRecognition(handlers());
    const rec = FakeRecognition.instances[0]!;
    expect(rec.started).toBe(true);
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
  });

  it("reports interim text as not-final, then final text as final", () => {
    const h = handlers();
    startVoiceRecognition(h);
    const rec = FakeRecognition.instances[0]!;
    rec.result([{ transcript: "move gym", isFinal: false }]);
    rec.result([{ transcript: "move gym after 8", isFinal: true }]);
    expect(h.transcripts).toEqual([
      ["move gym", false],
      ["move gym after 8", true],
    ]);
  });

  it("onEnd fires with the accumulated final transcript, trimmed", () => {
    const h = handlers();
    startVoiceRecognition(h);
    const rec = FakeRecognition.instances[0]!;
    rec.result([{ transcript: " move gym after 8 ", isFinal: true }]);
    rec.end();
    expect(h.ends).toEqual(["move gym after 8"]);
    expect(h.errors).toEqual([]);
  });

  it("concatenates multiple final segments with a single space", () => {
    const h = handlers();
    startVoiceRecognition(h);
    const rec = FakeRecognition.instances[0]!;
    rec.result([{ transcript: "move gym after 8", isFinal: true }]);
    rec.result([{ transcript: "don't move DSA", isFinal: true }]);
    rec.end();
    expect(h.ends).toEqual(["move gym after 8 don't move DSA"]);
  });

  it("an end with no result at all is empty_recording, not onEnd", () => {
    const h = handlers();
    startVoiceRecognition(h);
    FakeRecognition.instances[0]!.end();
    expect(h.ends).toEqual([]);
    expect(h.errors).toEqual([voiceCaptureError("empty_recording")]);
  });

  it("an end with only interim (never finalized) text is also empty_recording", () => {
    const h = handlers();
    startVoiceRecognition(h);
    const rec = FakeRecognition.instances[0]!;
    rec.result([{ transcript: "uh", isFinal: false }]);
    rec.end();
    expect(h.ends).toEqual([]);
    expect(h.errors).toEqual([voiceCaptureError("empty_recording")]);
  });
});

describe("startVoiceRecognition — errors", () => {
  it.each([
    ["not-allowed", "microphone_permission_denied"],
    ["permission-denied", "microphone_permission_denied"],
    ["service-not-allowed", "microphone_permission_denied"],
    ["no-speech", "empty_recording"],
    ["audio-capture", "recording_failed"],
    ["network", "recording_failed"],
  ] as const)("maps engine error %s to %s", (code, reason) => {
    const h = handlers();
    startVoiceRecognition(h);
    FakeRecognition.instances[0]!.error(code);
    expect(h.errors).toEqual([voiceCaptureError(reason)]);
  });

  it("never forwards the engine's own error string", () => {
    const h = handlers();
    startVoiceRecognition(h);
    FakeRecognition.instances[0]!.error("some-internal-engine-code");
    expect(JSON.stringify(h.errors)).not.toContain("some-internal-engine-code");
  });

  it("an 'aborted' engine error is swallowed, not surfaced", () => {
    const h = handlers();
    startVoiceRecognition(h);
    FakeRecognition.instances[0]!.error("aborted");
    expect(h.errors).toEqual([]);
    expect(h.ends).toEqual([]);
  });

  it("a synchronous start() failure (e.g. an already-active session) is recording_failed", () => {
    FakeRecognition.startThrows = new Error("InvalidStateError");
    const h = handlers();
    const session = startVoiceRecognition(h);
    expect(h.errors).toEqual([voiceCaptureError("recording_failed")]);
    expect(() => session.stop()).not.toThrow();
  });

  it("onerror and onend never both fire for the same session", () => {
    const h = handlers();
    startVoiceRecognition(h);
    const rec = FakeRecognition.instances[0]!;
    rec.error("network");
    rec.end(); // browsers may still fire onend after onerror
    expect(h.errors).toHaveLength(1);
    expect(h.ends).toHaveLength(0);
  });
});

describe("stop()", () => {
  it("asks the engine to stop; onEnd still fires once the engine finalizes", () => {
    const h = handlers();
    const session = startVoiceRecognition(h);
    const rec = FakeRecognition.instances[0]!;
    rec.result([{ transcript: "move gym", isFinal: true }]);
    session.stop();
    expect(rec.stopped).toBe(true);
    rec.end();
    expect(h.ends).toEqual(["move gym"]);
  });
  it("is a no-op after the session has already ended", () => {
    const h = handlers();
    const session = startVoiceRecognition(h);
    const rec = FakeRecognition.instances[0]!;
    rec.end();
    rec.stopped = false;
    session.stop();
    expect(rec.stopped).toBe(false);
  });
});

describe("cancel()", () => {
  it("aborts the engine immediately", () => {
    const session = startVoiceRecognition(handlers());
    session.cancel();
    expect(FakeRecognition.instances[0]!.aborted).toBe(true);
  });

  it("silences every handler permanently, even for an event already in flight", () => {
    const h = handlers();
    const session = startVoiceRecognition(h);
    const rec = FakeRecognition.instances[0]!;
    rec.result([{ transcript: "move gym", isFinal: false }]);
    session.cancel();
    // the browser's own trailing events, which cancel() cannot prevent it from firing:
    rec.result([{ transcript: "move gym after 8", isFinal: true }]);
    rec.error("network");
    rec.end();
    expect(h.transcripts).toEqual([["move gym", false]]); // only the pre-cancel one
    expect(h.errors).toEqual([]);
    expect(h.ends).toEqual([]);
  });

  it("still refuses to run even if a caller holds the pre-cancel handler reference directly — the internal cancelled flag, not just nulling the recognition object's own callback slots, is what guards it (models a browser that had already captured the callback before cancel() ran)", () => {
    const h = handlers();
    const session = startVoiceRecognition(h);
    const rec = FakeRecognition.instances[0]!;
    const capturedOnResult = rec.onresult;
    const capturedOnEnd = rec.onend;
    const capturedOnError = rec.onerror;
    session.cancel();
    capturedOnResult?.({
      resultIndex: 0,
      results: [Object.assign([{ transcript: "late" }], { isFinal: true })],
    });
    capturedOnEnd?.();
    capturedOnError?.({ error: "network" });
    expect(h.transcripts).toEqual([]);
    expect(h.ends).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("is idempotent", () => {
    const session = startVoiceRecognition(handlers());
    session.cancel();
    expect(() => session.cancel()).not.toThrow();
  });

  it("never calls the engine's abort() twice for one cancel()", () => {
    const session = startVoiceRecognition(handlers());
    const rec = FakeRecognition.instances[0]!;
    session.cancel();
    session.cancel();
    expect(rec.aborted).toBe(true); // sanity: it WAS aborted once; the guard just skips re-entry
  });
});

describe("session isolation", () => {
  it("a second session's engine events never reach the first session's handlers", () => {
    const first = handlers();
    startVoiceRecognition(first);
    const firstRec = FakeRecognition.instances[0]!;
    firstRec.result([{ transcript: "first session", isFinal: false }]);

    const second = handlers();
    startVoiceRecognition(second);
    const secondRec = FakeRecognition.instances[1]!;
    secondRec.result([{ transcript: "second session", isFinal: true }]);
    secondRec.end();

    expect(first.transcripts).toEqual([["first session", false]]);
    expect(second.ends).toEqual(["second session"]);
    // the first session's own engine firing late still only reaches the first session's handlers
    firstRec.end();
    expect(first.errors).toEqual([voiceCaptureError("empty_recording")]);
    expect(second.ends).toEqual(["second session"]); // unaffected
  });
});
