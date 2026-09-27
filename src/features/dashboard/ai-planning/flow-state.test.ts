import { describe, expect, it } from "vitest";
import {
  initialVoicePlanState,
  initialVoicePlanStateFor,
  reduceVoicePlan,
  type VoicePlanState,
} from "./flow-state";
import type { ProposalView } from "./proposal-view";
import type { ConfirmAiProposalOutcome } from "@/server/services/ai-confirmation";

const VIEW: ProposalView = {
  proposalId: "p1",
  understood: "ok",
  unresolved: [],
  status: "valid",
  accepted: [{ ref: "t1", kind: "move", newStart: new Date("2026-10-01T20:00:00Z"), reason: "x" }],
  rejectedMessages: [],
  conflictCount: 0,
  baseRevision: 1,
  isStale: false,
};
const OUTCOME: ConfirmAiProposalOutcome = { revisionNumber: 2, tasks: [] };

describe("required chain: idle -> recording -> transcribing -> transcript_review -> generating -> proposal_ready", () => {
  it("walks the whole chain for voice input", () => {
    let s: VoicePlanState = initialVoicePlanState;
    expect(s.status).toBe("idle");

    s = reduceVoicePlan(s, { type: "start_recording", epoch: 1 });
    expect(s).toMatchObject({ status: "recording", epoch: 1, transcript: "" });

    s = reduceVoicePlan(s, { type: "transcript_progress", epoch: 1, transcript: "move gym" });
    expect(s).toMatchObject({ status: "recording", transcript: "move gym" });

    s = reduceVoicePlan(s, { type: "stop_recording", epoch: 1 });
    expect(s).toMatchObject({ status: "transcribing", epoch: 1, transcript: "move gym" });

    s = reduceVoicePlan(s, { type: "recognition_ended", epoch: 1, transcript: "move gym after 8" });
    expect(s).toMatchObject({
      status: "transcript_review",
      source: "voice",
      text: "move gym after 8",
    });

    s = reduceVoicePlan(s, { type: "submit", epoch: 1 });
    expect(s).toMatchObject({ status: "generating", source: "voice", text: "move gym after 8" });

    s = reduceVoicePlan(s, { type: "proposal_ready", epoch: 1, view: VIEW });
    expect(s).toMatchObject({ status: "proposal_ready", source: "voice", view: VIEW });
  });

  it("walks the same chain for typed input, skipping the recording states entirely", () => {
    let s: VoicePlanState = initialVoicePlanState;
    s = reduceVoicePlan(s, { type: "start_typing" });
    expect(s).toMatchObject({ status: "transcript_review", source: "typed", text: "" });
    s = reduceVoicePlan(s, { type: "edit_text", text: "move gym after 8" });
    s = reduceVoicePlan(s, { type: "submit", epoch: 0 });
    expect(s).toMatchObject({ status: "generating", source: "typed", text: "move gym after 8" });
  });

  it("the resulting state is identical in shape regardless of source — only `source` differs", () => {
    const voice = reduceVoicePlan(
      { status: "transcript_review", epoch: 0, source: "voice", text: "x" },
      { type: "submit", epoch: 0 },
    );
    const typed = reduceVoicePlan(
      { status: "transcript_review", epoch: 0, source: "typed", text: "x" },
      { type: "submit", epoch: 0 },
    );
    expect({ ...voice, source: "s" }).toEqual({ ...typed, source: "s" });
  });
});

describe("proposal_ready -> confirming -> applied", () => {
  it("requires an explicit confirm event; proposal_ready alone never applies anything", () => {
    const ready: VoicePlanState = {
      status: "proposal_ready",
      epoch: 1,
      source: "voice",
      text: "x",
      view: VIEW,
    };
    const confirming = reduceVoicePlan(ready, { type: "confirm", epoch: 1 });
    expect(confirming).toMatchObject({ status: "confirming", epoch: 1, view: VIEW });
    const applied = reduceVoicePlan(confirming, { type: "confirmed", epoch: 1, outcome: OUTCOME });
    expect(applied).toEqual({ status: "applied", epoch: 1, outcome: OUTCOME });
  });
});

describe("error and cancel reachable from every meaningful state", () => {
  const states: VoicePlanState[] = [
    { status: "idle", epoch: 0 },
    { status: "recording", epoch: 0, transcript: "x" },
    { status: "transcribing", epoch: 0, transcript: "x" },
    { status: "transcript_review", epoch: 0, source: "typed", text: "x" },
    { status: "generating", epoch: 0, source: "typed", text: "x" },
    { status: "proposal_ready", epoch: 0, source: "typed", text: "x", view: VIEW },
    { status: "confirming", epoch: 0, source: "typed", text: "x", view: VIEW },
    { status: "applied", epoch: 0, outcome: OUTCOME },
  ];
  it.each(states)("cancel always returns to idle with a bumped epoch, from %o", (state) => {
    const next = reduceVoicePlan(state, { type: "cancel" });
    expect(next).toEqual({ status: "idle", epoch: state.epoch + 1 });
  });

  it("a recognition error while recording or transcribing goes to error, returnTo idle", () => {
    for (const status of ["recording", "transcribing"] as const) {
      const state: VoicePlanState =
        status === "recording"
          ? { status, epoch: 3, transcript: "x" }
          : { status, epoch: 3, transcript: "x" };
      const next = reduceVoicePlan(state, {
        type: "recognition_error",
        epoch: 3,
        error: { reason: "recording_failed", message: "Recording failed. Try again." },
      });
      expect(next).toEqual({
        status: "error",
        epoch: 3,
        message: "Recording failed. Try again.",
        returnTo: "idle",
      });
    }
  });

  it("a proposal or confirm failure goes to error, returnTo transcript_review (the text is not lost)", () => {
    const generating: VoicePlanState = {
      status: "generating",
      epoch: 1,
      source: "voice",
      text: "x",
    };
    expect(
      reduceVoicePlan(generating, { type: "proposal_failed", epoch: 1, message: "boom" }),
    ).toEqual({ status: "error", epoch: 1, message: "boom", returnTo: "transcript_review" });
    const confirming: VoicePlanState = {
      status: "confirming",
      epoch: 1,
      source: "voice",
      text: "x",
      view: VIEW,
    };
    expect(
      reduceVoicePlan(confirming, { type: "confirm_failed", epoch: 1, message: "stale" }),
    ).toEqual({ status: "error", epoch: 1, message: "stale", returnTo: "transcript_review" });
  });

  it("reset always returns to idle with a bumped epoch, from any state", () => {
    for (const state of states) {
      expect(reduceVoicePlan(state, { type: "reset" })).toEqual({
        status: "idle",
        epoch: state.epoch + 1,
      });
    }
  });
});

describe("stale async results cannot overwrite newer state", () => {
  it("a late transcript_progress from an old recording epoch is dropped", () => {
    const state: VoicePlanState = { status: "recording", epoch: 5, transcript: "current" };
    const next = reduceVoicePlan(state, {
      type: "transcript_progress",
      epoch: 4,
      transcript: "stale",
    });
    expect(next).toBe(state); // unchanged, not just equal
  });

  it("a late recognition_ended from a cancelled/superseded recording is dropped", () => {
    const idleAfterCancel: VoicePlanState = { status: "idle", epoch: 6 };
    const next = reduceVoicePlan(idleAfterCancel, {
      type: "recognition_ended",
      epoch: 5,
      transcript: "should never appear",
    });
    expect(next).toBe(idleAfterCancel);
  });

  it("a late recognition_ended after the user already started a NEW recording is dropped, not merged", () => {
    const newerRecording: VoicePlanState = {
      status: "recording",
      epoch: 7,
      transcript: "new words",
    };
    const next = reduceVoicePlan(newerRecording, {
      type: "recognition_ended",
      epoch: 6,
      transcript: "old words",
    });
    expect(next).toBe(newerRecording);
  });

  it("a late proposal_ready after cancel is dropped — never silently shows a stale proposal", () => {
    const idle: VoicePlanState = { status: "idle", epoch: 3 };
    const next = reduceVoicePlan(idle, { type: "proposal_ready", epoch: 2, view: VIEW });
    expect(next).toBe(idle);
  });

  it("a late proposal_ready after a fresh recording started is dropped, not merged into it", () => {
    const recording: VoicePlanState = { status: "recording", epoch: 3, transcript: "" };
    const next = reduceVoicePlan(recording, { type: "proposal_ready", epoch: 2, view: VIEW });
    expect(next).toBe(recording);
  });

  it("a late confirmed after cancel never silently marks the plan applied", () => {
    const idle: VoicePlanState = { status: "idle", epoch: 4 };
    const next = reduceVoicePlan(idle, { type: "confirmed", epoch: 3, outcome: OUTCOME });
    expect(next).toBe(idle);
  });

  it("a duplicate confirm click (already confirming) does not start a second confirmation", () => {
    const confirming: VoicePlanState = {
      status: "confirming",
      epoch: 2,
      source: "voice",
      text: "x",
      view: VIEW,
    };
    const next = reduceVoicePlan(confirming, { type: "confirm", epoch: 2 });
    expect(next).toBe(confirming);
  });
});

describe("resuming a persisted proposal (Phase 5.5)", () => {
  it("initialVoicePlanStateFor(null) is the ordinary idle start", () => {
    expect(initialVoicePlanStateFor(null)).toEqual({ status: "idle", epoch: 0 });
  });

  it("initialVoicePlanStateFor(view) starts directly in proposal_ready, with no AI call implied", () => {
    const state = initialVoicePlanStateFor(VIEW);
    expect(state).toEqual({
      status: "proposal_ready",
      epoch: 0,
      source: null,
      text: null,
      view: VIEW,
    });
  });

  it("a resumed proposal reaches confirming/applied through the exact same events as a fresh one", () => {
    let s = initialVoicePlanStateFor(VIEW);
    s = reduceVoicePlan(s, { type: "confirm", epoch: 0 });
    expect(s).toMatchObject({ status: "confirming", view: VIEW });
    s = reduceVoicePlan(s, { type: "confirmed", epoch: 0, outcome: OUTCOME });
    expect(s).toEqual({ status: "applied", epoch: 0, outcome: OUTCOME });
  });
});

describe("confirm is refused for anything not fully valid or found stale (Phase 5.5)", () => {
  it("refuses when status is partially_valid, even with an accepted change present", () => {
    const ready: VoicePlanState = {
      status: "proposal_ready",
      epoch: 1,
      source: "typed",
      text: "x",
      view: { ...VIEW, status: "partially_valid" },
    };
    expect(reduceVoicePlan(ready, { type: "confirm", epoch: 1 })).toBe(ready);
  });

  it("refuses when status is invalid", () => {
    const ready: VoicePlanState = {
      status: "proposal_ready",
      epoch: 1,
      source: "typed",
      text: "x",
      view: { ...VIEW, status: "invalid", accepted: [] },
    };
    expect(reduceVoicePlan(ready, { type: "confirm", epoch: 1 })).toBe(ready);
  });

  it("refuses a stale resumed proposal even though its own status is valid", () => {
    const ready: VoicePlanState = {
      status: "proposal_ready",
      epoch: 1,
      source: null,
      text: null,
      view: { ...VIEW, isStale: true },
    };
    expect(reduceVoicePlan(ready, { type: "confirm", epoch: 1 })).toBe(ready);
  });

  it("accepts when valid and not stale", () => {
    const ready: VoicePlanState = {
      status: "proposal_ready",
      epoch: 1,
      source: "typed",
      text: "x",
      view: VIEW,
    };
    expect(reduceVoicePlan(ready, { type: "confirm", epoch: 1 }).status).toBe("confirming");
  });
});

describe("submission guards", () => {
  it("refuses to submit an empty or whitespace-only transcript", () => {
    for (const text of ["", "   ", "\n\t"]) {
      const state: VoicePlanState = {
        status: "transcript_review",
        epoch: 1,
        source: "typed",
        text,
      };
      expect(reduceVoicePlan(state, { type: "submit", epoch: 1 })).toBe(state);
    }
  });

  it("a stop_recording with an empty transcript still reaches transcribing (emptiness is judged at recognition_ended/error, not here)", () => {
    const state: VoicePlanState = { status: "recording", epoch: 1, transcript: "" };
    expect(reduceVoicePlan(state, { type: "stop_recording", epoch: 1 })).toMatchObject({
      status: "transcribing",
      transcript: "",
    });
  });

  it("edit_text only applies while reviewing a transcript", () => {
    const idle: VoicePlanState = { status: "idle", epoch: 0 };
    expect(reduceVoicePlan(idle, { type: "edit_text", text: "anything" })).toBe(idle);
  });

  it("submit is refused from every state except transcript_review", () => {
    for (const state of [
      { status: "idle", epoch: 0 } as const,
      { status: "recording", epoch: 0, transcript: "x" } as const,
      { status: "generating", epoch: 0, source: "typed", text: "x" } as const,
    ]) {
      expect(reduceVoicePlan(state, { type: "submit", epoch: 0 })).toBe(state);
    }
  });
});

describe("cannot skip the confirmation step", () => {
  it("there is no event that reaches 'applied' without first passing through 'confirming'", () => {
    // Structural guarantee: 'confirmed' only ever transitions FROM 'confirming' (see the
    // reducer's own guard); every other source state is a no-op. Exercise a representative
    // sample of "wrong" source states to demonstrate this, rather than only the happy path.
    for (const state of [
      { status: "idle", epoch: 1 } as const,
      { status: "transcript_review", epoch: 1, source: "voice", text: "x" } as const,
      { status: "generating", epoch: 1, source: "voice", text: "x" } as const,
      { status: "proposal_ready", epoch: 1, source: "voice", text: "x", view: VIEW } as const,
    ]) {
      expect(reduceVoicePlan(state, { type: "confirmed", epoch: 1, outcome: OUTCOME })).toBe(state);
    }
  });
});
