import { describe, expect, it } from "vitest";
import { detectScheduleConflicts } from "./conflicts";

const t = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 22, h, m));
const task = (
  id: string,
  start: Date,
  end: Date,
  extra: Partial<{ status: "upcoming" | "completed" | "skipped"; unscheduled: boolean }> = {},
) => ({
  id,
  status: "upcoming" as const,
  unscheduled: false,
  scheduledStart: start,
  scheduledEnd: end,
  ...extra,
});
const now = t(8);

describe("detectScheduleConflicts", () => {
  it("finds overlapping pairs", () => {
    expect(
      detectScheduleConflicts([task("a", t(9), t(10)), task("b", t(9, 30), t(10, 30))], now),
    ).toEqual([{ firstTaskId: "a", secondTaskId: "b" }]);
  });

  it("treats back-to-back tasks as compatible (half-open)", () => {
    expect(detectScheduleConflicts([task("a", t(9), t(10)), task("b", t(10), t(11))], now)).toEqual(
      [],
    );
  });

  it("ignores resolved and unscheduled tasks", () => {
    expect(
      detectScheduleConflicts(
        [
          task("a", t(9), t(10)),
          task("done", t(9), t(10), { status: "completed" }),
          task("skip", t(9), t(10), { status: "skipped" }),
          task("nofit", t(9), t(10), { unscheduled: true }),
        ],
        now,
      ),
    ).toEqual([]);
  });

  it("ignores overlaps that are already over", () => {
    expect(
      detectScheduleConflicts([task("a", t(6), t(7)), task("b", t(6, 30), t(7, 30))], now),
    ).toEqual([]);
  });

  it("reports every pair in a triple overlap, deterministically", () => {
    const out = detectScheduleConflicts(
      [task("c", t(9, 10), t(9, 50)), task("a", t(9), t(10)), task("b", t(9, 5), t(9, 55))],
      now,
    );
    expect(out).toEqual([
      { firstTaskId: "a", secondTaskId: "b" },
      { firstTaskId: "a", secondTaskId: "c" },
      { firstTaskId: "b", secondTaskId: "c" },
    ]);
  });
});
