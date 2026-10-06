import { describe, expect, it } from "vitest";
import {
  briefingPlanInputSchema,
  briefingProposalOutputSchema,
  parseRawProposal,
} from "./ai-planning";

const ID = "0b7e3c1e-5a52-4b6c-9d0f-2f1a4f5e6a77";
const create = (over: Record<string, unknown> = {}) => ({
  kind: "create",
  title: "Deep work",
  start: "2026-10-01T10:00",
  durationMinutes: 60,
  priority: "medium",
  taskKind: "flexible",
  timeStated: false,
  reason: "Morning gap.",
  ...over,
});
const env = (changes: unknown[]) => ({ understood: "ok", changes, unresolved: [] });
const parse = (changes: unknown[], allowCreate = true) =>
  parseRawProposal(env(changes), { allowCreate });
const rejectionCodes = (r: ReturnType<typeof parseRawProposal>) =>
  r.ok ? r.rejected.map((x) => [x.changeIndex, x.code]) : null;

describe("briefingPlanInputSchema — all the browser may send", () => {
  const ok = { id: ID, planningDate: "2026-10-01", source: "typed", note: "" };
  it("accepts a date, a source and an optional (possibly empty) note", () => {
    expect(briefingPlanInputSchema.safeParse(ok).success).toBe(true);
    expect(
      briefingPlanInputSchema.safeParse({ ...ok, source: "voice", note: " keep evening free " }),
    ).toMatchObject({ success: true, data: { note: "keep evening free" } });
  });
  it.each([
    ["the briefing text", { briefing: "Finish report" }],
    ["a briefing id", { briefingId: ID }],
    ["a day id", { dayId: ID }],
    ["a user id", { userId: ID }],
    ["a timezone", { timezone: "UTC" }],
    ["a clock", { now: "2026-10-01T09:00:00Z" }],
    ["tasks", { tasks: [] }],
  ])("refuses %s — it cannot even be expressed", (_label, extra) => {
    expect(briefingPlanInputSchema.safeParse({ ...ok, ...extra }).success).toBe(false);
  });
  it("refuses a bad id, a bad date, a bad source and an over-long note", () => {
    for (const bad of [
      { id: "nope" },
      { planningDate: "tomorrow" },
      { source: "telepathy" },
      { note: "x".repeat(1001) },
    ]) {
      expect(briefingPlanInputSchema.safeParse({ ...ok, ...bad }).success).toBe(false);
    }
  });
});

describe("parseRawProposal with creation allowed", () => {
  it("parses a create into proposal.changes with its original position", () => {
    const r = parse([{ kind: "unschedule", ref: "t1", reason: "r" }, create()]);
    if (!r.ok) throw new Error("should parse");
    expect(r.proposal.changes.map((c) => c.kind)).toEqual(["unschedule", "create"]);
    expect(r.sourceIndexes).toEqual([0, 1]);
    expect(r.rejected).toEqual([]);
  });

  it.each(["flexible", "deadline", "optional", "fixed"])("accepts task kind %s", (taskKind) => {
    const r = parse([create({ taskKind, timeStated: taskKind === "fixed" })]);
    expect(r.ok && r.rejected).toEqual([]);
  });

  it("a malformed create does not sink the valid ones next to it", () => {
    const r = parse([
      create({ title: "Good" }),
      create({ durationMinutes: 4 }),
      create({ title: "Also good", start: "2026-10-01T12:00" }),
    ]);
    if (!r.ok) throw new Error("should parse");
    expect(r.proposal.changes).toHaveLength(2);
    expect(r.sourceIndexes).toEqual([0, 2]);
    expect(rejectionCodes(r)).toEqual([[1, "invalid_duration"]]);
  });

  it.each([
    ["an over-long title", { title: "x".repeat(101) }, "invalid_title"],
    ["a blank title", { title: "  " }, "invalid_title"],
    ["a non-string title", { title: 7 }, "invalid_title"],
    ["recurring kind", { taskKind: "recurring" }, "invalid_task_kind"],
    ["an unknown kind", { taskKind: "epic" }, "invalid_task_kind"],
    ["a missing kind", { taskKind: undefined }, "invalid_task_kind"],
    ["an unknown priority", { priority: "urgent" }, "invalid_priority"],
    ["a fractional duration", { durationMinutes: 30.5 }, "invalid_duration"],
    ["a string duration", { durationMinutes: "30" }, "invalid_duration"],
    ["a 0 duration", { durationMinutes: 0 }, "invalid_duration"],
    ["a 25h duration", { durationMinutes: 1500 }, "invalid_duration"],
    ["a model-supplied end", { end: "2026-10-01T11:00" }, "invalid_duration"],
    ["an endTime", { endTime: "2026-10-01T11:00" }, "invalid_duration"],
    ["a task id", { taskId: "00000000-0000-4000-8000-000000000001" }, "unsupported_change"],
    ["a source", { source: "user" }, "unsupported_change"],
    ["notes", { notes: "secret" }, "unsupported_change"],
    ["a status", { status: "completed" }, "unsupported_change"],
  ])("rejects %s with a specific code", (_label, over, code) => {
    const r = parse([create(over)]);
    if (!r.ok) throw new Error("should parse");
    expect(r.proposal.changes).toEqual([]);
    expect(rejectionCodes(r)).toEqual([[0, code]]);
    // fixed text only — never the model's words
    expect(JSON.stringify(r.rejected)).not.toContain("secret");
  });

  it("a fixed task claiming no stated time is well-formed: the DOMAIN (not the parser) judges it", () => {
    const r = parse([create({ taskKind: "fixed", timeStated: false })]);
    expect(r.ok && r.proposal.changes).toHaveLength(1);
  });

  it("a missing field is 'incomplete', not a crash", () => {
    const { reason: _reason, ...noReason } = create();
    void _reason;
    const r = parse([noReason]);
    expect(rejectionCodes(r)).toEqual([[0, "unsupported_change"]]);
  });

  it("whole-envelope problems still fail the parse", () => {
    expect(parseRawProposal({ understood: "x" }, { allowCreate: true }).ok).toBe(false);
    expect(parse(Array.from({ length: 21 }, () => create()))).toMatchObject({
      ok: false,
      reason: "too_many_changes",
    });
    expect(parseRawProposal("nonsense", { allowCreate: true }).ok).toBe(false);
  });
});

describe("parseRawProposal in the ordinary (Ask AI) mode is unchanged: create is still unsupported", () => {
  it("routes a create to `rejected`, never to changes", () => {
    for (const allow of [false, undefined]) {
      const r = parseRawProposal(env([create()]), { allowCreate: allow });
      if (!r.ok) throw new Error("should parse");
      expect(r.proposal.changes).toEqual([]);
      expect(r.rejected[0]).toMatchObject({ code: "unsupported_change", ref: null });
    }
    const noOptions = parseRawProposal(env([create()]));
    expect(noOptions.ok && noOptions.rejected[0]!.code).toBe("unsupported_change");
  });
});

describe("briefingProposalOutputSchema (the provider-facing contract)", () => {
  it("accepts a well-formed output and refuses extra/hidden fields at every level", () => {
    expect(briefingProposalOutputSchema.safeParse(env([create()])).success).toBe(true);
    expect(
      briefingProposalOutputSchema.safeParse({ ...env([create()]), sql: "drop" }).success,
    ).toBe(false);
    expect(briefingProposalOutputSchema.safeParse(env([create({ end: "x" })])).success).toBe(false);
  });
});
