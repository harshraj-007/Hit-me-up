import { describe, expect, it } from "vitest";
import {
  eodToolInputSchema,
  parseRawInterpretation,
  storedEodFactsSchema,
  storedEodInterpretationSchema,
} from "./eod";

const GOOD = {
  summary: "A steady day.",
  takeaway: "Protect the afternoon.",
  patterns: [{ text: "[t1] moved a lot.", refs: ["t1"] }],
  carryForward: [{ ref: "t2", suggestion: "Give it a slot." }],
};

describe("parseRawInterpretation", () => {
  it("accepts a well-formed payload", () => {
    const r = parseRawInterpretation(GOOD);
    expect(r.ok && r.parsed).toMatchObject({
      summary: "A steady day.",
      takeaway: "Protect the afternoon.",
      patterns: [{ text: "[t1] moved a lot.", refs: ["t1"] }],
      carryForward: [{ ref: "t2", suggestion: "Give it a slot." }],
      rejected: [],
    });
  });

  it.each([
    ["null", null],
    ["a string", "just text"],
    ["an array", []],
    ["a number", 42],
    ["undefined", undefined],
    ["an empty object", {}],
  ])("rejects %s", (_label, payload) => {
    expect(parseRawInterpretation(payload).ok).toBe(false);
  });

  it.each(["summary", "takeaway", "patterns", "carryForward"])(
    "rejects a payload missing %s",
    (key) => {
      const { [key]: _removed, ...rest } = GOOD as Record<string, unknown>;
      void _removed;
      expect(parseRawInterpretation(rest).ok).toBe(false);
    },
  );

  it.each([
    ["summary as a number", { summary: 5 }],
    ["takeaway as an object", { takeaway: {} }],
    ["patterns as a string", { patterns: "none" }],
    ["carryForward as null", { carryForward: null }],
    ["a blank summary", { summary: "   " }],
    ["a hidden extra field", { taskIds: ["x"] }],
    ["an invented status field", { markCompleted: true }],
    ["an enormous summary", { summary: "x".repeat(5000) }],
    ["too many patterns", { patterns: Array.from({ length: 21 }, () => ({})) }],
  ])("rejects %s", (_label, over) => {
    expect(parseRawInterpretation({ ...GOOD, ...over }).ok).toBe(false);
  });

  it("moves a malformed list ITEM into `rejected` without sinking the rest", () => {
    const r = parseRawInterpretation({
      ...GOOD,
      patterns: [
        { text: "ok", refs: [] },
        { text: 5, refs: [] },
        { text: "extra", refs: [], hidden: 1 },
      ],
      carryForward: [{ ref: "t1" }, { ref: "t2", suggestion: "fine" }, "nonsense"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.patterns).toEqual([{ text: "ok", refs: [] }]);
    expect(r.parsed.carryForward).toEqual([{ ref: "t2", suggestion: "fine" }]);
    expect(r.parsed.rejected.map((d) => `${d.section}:${d.index}`)).toEqual([
      "pattern:1",
      "pattern:2",
      "carry_forward:0",
      "carry_forward:2",
    ]);
  });

  it("trims the prose it keeps", () => {
    const r = parseRawInterpretation({ ...GOOD, summary: "  spaced  " });
    expect(r.ok && r.parsed.summary).toBe("spaced");
  });

  it("never throws, whatever it is given", () => {
    for (const bad of [
      Symbol("x"),
      () => 1,
      new Date(),
      Object.create(null),
      { toJSON: () => ({}) },
    ]) {
      expect(() => parseRawInterpretation(bad)).not.toThrow();
    }
  });
});

describe("eodToolInputSchema (what the model is told to produce)", () => {
  it("is strict at every level, so no hidden field can ride along", () => {
    expect(eodToolInputSchema.safeParse({ ...GOOD, extra: 1 }).success).toBe(false);
    expect(
      eodToolInputSchema.safeParse({ ...GOOD, patterns: [{ text: "t", refs: [], extra: 1 }] })
        .success,
    ).toBe(false);
    expect(eodToolInputSchema.safeParse(GOOD).success).toBe(true);
  });
});

describe("stored shapes (read boundary)", () => {
  const FACTS = {
    planningDate: "2026-10-01",
    timezone: "UTC",
    asOf: "2026-10-01T21:00",
    tasks: [
      {
        ref: "t1",
        title: "Write",
        priority: "high",
        kind: "flexible",
        outcome: "completed_on_time",
        start: "2026-10-01T09:00",
        end: "2026-10-01T10:00",
        durationMinutes: 60,
        completedAt: "2026-10-01T09:50",
        minutesLate: null,
        rescheduleCount: 0,
        netShiftMinutes: null,
      },
    ],
    totals: {
      total: 1,
      completed: 1,
      completedOnTime: 1,
      completedLate: 0,
      skipped: 0,
      unresolved: 0,
      slipped: 0,
      inProgress: 0,
      notYetDue: 0,
      unscheduled: 0,
      completionRatio: 1,
      plannedMinutes: 60,
      completedMinutes: 60,
      skippedMinutes: 0,
      unresolvedMinutes: 0,
      highPriorityTotal: 1,
      highPriorityCompleted: 1,
      rescheduledTasks: 0,
      totalReschedules: 0,
      planRevisions: 0,
    },
  };

  it("accepts valid facts and interpretation", () => {
    expect(storedEodFactsSchema.safeParse(FACTS).success).toBe(true);
    expect(storedEodInterpretationSchema.safeParse(GOOD).success).toBe(true);
  });

  it("rejects facts carrying an unknown field (such as a smuggled task id), an invalid outcome, or a bad time", () => {
    expect(storedEodFactsSchema.safeParse({ ...FACTS, userId: "u" }).success).toBe(false);
    const t = FACTS.tasks[0]!;
    expect(
      storedEodFactsSchema.safeParse({ ...FACTS, tasks: [{ ...t, id: "uuid" }] }).success,
    ).toBe(false);
    expect(
      storedEodFactsSchema.safeParse({ ...FACTS, tasks: [{ ...t, outcome: "magic" }] }).success,
    ).toBe(false);
    expect(
      storedEodFactsSchema.safeParse({ ...FACTS, tasks: [{ ...t, start: "9am" }] }).success,
    ).toBe(false);
  });

  it("rejects an interpretation that is over its limits", () => {
    expect(
      storedEodInterpretationSchema.safeParse({ ...GOOD, summary: "x".repeat(401) }).success,
    ).toBe(false);
    expect(
      storedEodInterpretationSchema.safeParse({ ...GOOD, takeaway: "x".repeat(201) }).success,
    ).toBe(false);
  });
});
