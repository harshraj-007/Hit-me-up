import { describe, expect, it } from "vitest";
import { calculateDayProgress } from "./progress";
import type { TaskStatus } from "./types";

const of = (...statuses: TaskStatus[]) => statuses.map((status) => ({ status }));

describe("calculateDayProgress", () => {
  it("has no ratio for an empty day", () => {
    expect(calculateDayProgress([])).toEqual({
      completed: 0,
      skipped: 0,
      total: 0,
      countable: 0,
      ratio: null,
    });
  });

  it("is 100% when everything is completed", () => {
    expect(calculateDayProgress(of("completed", "completed")).ratio).toBe(1);
  });

  it("is 0 (not null) when tasks exist but none are done", () => {
    expect(calculateDayProgress(of("upcoming", "upcoming")).ratio).toBe(0);
  });

  it("uses completed / (total - skipped) for a mixed day", () => {
    const p = calculateDayProgress(of("completed", "upcoming", "skipped", "skipped"));
    expect(p).toMatchObject({ completed: 1, skipped: 2, total: 4, countable: 2, ratio: 0.5 });
  });

  it("does not let skipped tasks move the ratio", () => {
    const without = calculateDayProgress(of("completed", "upcoming"));
    const withSkips = calculateDayProgress(of("completed", "upcoming", "skipped", "skipped"));
    expect(withSkips.ratio).toBe(without.ratio);
  });

  it("hides the ratio when every task is skipped", () => {
    expect(calculateDayProgress(of("skipped", "skipped")).ratio).toBeNull();
  });

  it("counts unresolved tasks (late or not — all 'upcoming' when stored) as not done", () => {
    // Late is derived, so a late task is stored as `upcoming` and stays in the denominator.
    expect(calculateDayProgress(of("completed", "upcoming")).countable).toBe(2);
  });
});
