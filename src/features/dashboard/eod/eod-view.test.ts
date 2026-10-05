import { describe, expect, it } from "vitest";
import { computeEodFacts, type EodInterpretation, type EodReportView } from "@/domain/eod";
import { at, makeTask, PLANNING_DATE, TZ } from "../../../../tests/support/ai-planning-fixtures";
import { buildEodDisplay, formatLocalClock } from "./eod-view";

const tasks = [
  makeTask({ title: "Gym", status: "completed", completedAt: at(9, 30), start: at(8), end: at(9) }),
  makeTask({ title: "Skipped thing", status: "skipped", start: at(9), end: at(10) }),
  makeTask({ title: "Essay", start: at(14), end: at(16) }),
  makeTask({ title: "Evening call", start: at(22), end: at(23) }),
  makeTask({ title: "Night shift", start: at(23, 30), end: at(1, 0, 1) }),
];
const facts = computeEodFacts({
  planningDate: PLANNING_DATE,
  timezone: TZ,
  now: at(21),
  tasks,
  history: [],
  revisions: [1, 2, 3].map((revisionNumber) => ({ revisionNumber })),
});

function view(over: Partial<EodInterpretation> = {}, isStale = false): EodReportView {
  return {
    isStale,
    report: {
      id: "r1",
      dayId: "d1",
      facts,
      interpretation: {
        summary: "[t1] went well; [t3] did not.",
        takeaway: "Start with [t3] tomorrow.",
        patterns: [{ text: "[t3] keeps slipping.", refs: ["t3"] }],
        carryForward: [{ ref: "t3", suggestion: "Give it the first slot." }],
        ...over,
      },
      promptVersion: "v1",
      stateFingerprint: "a".repeat(64),
      createdAt: at(21),
    },
  };
}

describe("formatLocalClock", () => {
  it.each([
    ["2026-10-01T00:05", "12:05 AM"],
    ["2026-10-01T09:14", "9:14 AM"],
    ["2026-10-01T12:00", "12:00 PM"],
    ["2026-10-01T21:30", "9:30 PM"],
    ["2026-10-01T23:59", "11:59 PM"],
  ])("%s → %s", (input, expected) => {
    expect(formatLocalClock(input)).toBe(expected);
  });
});

describe("buildEodDisplay", () => {
  const d = buildEodDisplay(view());

  it("renders the model's [tN] placeholders as the user's own task titles", () => {
    expect(d.summary).toBe("Gym went well; Essay did not.");
    expect(d.takeaway).toBe("Start with Essay tomorrow.");
    expect(d.patterns).toEqual(["Essay keeps slipping."]);
  });

  it("takes every number from the deterministic facts, never from the prose", () => {
    expect(d.stats).toEqual([
      { key: "done", label: "done", value: 1 },
      { key: "skipped", label: "skipped", value: 1 },
      { key: "open", label: "still open", value: 3 },
    ]);
    // (Gym was completed after its scheduled end, so one task finished late.)
    expect(d.notes).toEqual(["1 task finished late", "The plan changed 2 times"]);
  });

  it("lists EVERY unresolved task under carry-forward — a task the model forgot does not vanish", () => {
    expect(d.carryForward.map((c) => c.title)).toEqual(["Essay", "Evening call", "Night shift"]);
    expect(d.carryForward.find((c) => c.title === "Essay")!.suggestion).toBe(
      "Give it the first slot.",
    );
    expect(d.carryForward.find((c) => c.title === "Evening call")!.suggestion).toBeNull();
  });

  it("never lists a completed or skipped task as carried forward", () => {
    const titles = d.carryForward.map((c) => c.title);
    expect(titles).not.toContain("Gym");
    expect(titles).not.toContain("Skipped thing");
  });

  it("labels each carried task from its deterministic outcome", () => {
    expect(d.carryForward.map((c) => c.status)).toEqual([
      "Past its time",
      "Not started",
      "Not started",
    ]);
  });

  it("formats a task's window in the day's local time and marks one that ends after midnight", () => {
    expect(d.carryForward[0]!.when).toBe("2:00 – 4:00 PM");
    expect(d.carryForward[2]!.when).toBe("11:30 PM – 1:00 AM (next day)");
  });

  it("says when the facts were computed, in local time", () => {
    expect(d.reviewedAt).toBe("Reviewed at 9:00 PM");
  });

  it("passes staleness through untouched", () => {
    expect(buildEodDisplay(view({}, true)).isStale).toBe(true);
    expect(d.isStale).toBe(false);
  });

  it("shows no patterns section content when the model gave none", () => {
    expect(buildEodDisplay(view({ patterns: [] })).patterns).toEqual([]);
  });

  it("notes late finishes and moves only when they happened", () => {
    const plain = buildEodDisplay({
      ...view(),
      report: {
        ...view().report,
        facts: {
          ...facts,
          totals: { ...facts.totals, planRevisions: 0, completedLate: 0, rescheduledTasks: 0 },
        },
      },
    });
    expect(plain.notes).toEqual([]);
    const busy = buildEodDisplay({
      ...view(),
      report: {
        ...view().report,
        facts: {
          ...facts,
          totals: {
            ...facts.totals,
            completedLate: 2,
            rescheduledTasks: 1,
            totalReschedules: 3,
            planRevisions: 1,
          },
        },
      },
    });
    expect(busy.notes).toEqual([
      "2 tasks finished late",
      "1 task moved (3 times in all)",
      "The plan changed 1 time",
    ]);
  });
});
