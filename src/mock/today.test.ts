import { describe, expect, it } from "vitest";
import { applyMockReplan, buildMockDay, computeDaySummary } from "./today";

const NOW = new Date(2026, 8, 22, 19, 0);

describe("buildMockDay", () => {
  it("returns tasks sorted by start time, anchored around `now`", () => {
    const tasks = buildMockDay(NOW);
    expect(tasks.length).toBeGreaterThan(0);
    const starts = tasks.map((t) => t.start.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("always includes exactly one task spanning `now`", () => {
    const tasks = buildMockDay(NOW);
    expect(tasks.filter((t) => t.status === "current")).toHaveLength(1);
  });
});

describe("applyMockReplan", () => {
  it("never changes a task the user already resolved", () => {
    const tasks = buildMockDay(NOW).map((t) =>
      t.id === "study-group" ? { ...t, status: "completed" as const } : t,
    );
    const replanned = applyMockReplan(tasks, NOW);
    const studyGroup = replanned.find((t) => t.id === "study-group");
    expect(studyGroup?.status).toBe("completed");
  });

  it("inserts the new task exactly once, even if replanned twice", () => {
    const once = applyMockReplan(buildMockDay(NOW), NOW);
    const twice = applyMockReplan(once, NOW);
    expect(twice.filter((t) => t.id === "advisor-call")).toHaveLength(1);
  });

  it("keeps the result sorted by start time", () => {
    const replanned = applyMockReplan(buildMockDay(NOW), NOW);
    const starts = replanned.map((t) => t.start.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

describe("computeDaySummary", () => {
  it("counts completed tasks and remaining minutes from `now`", () => {
    const tasks = buildMockDay(NOW);
    const summary = computeDaySummary(tasks, NOW);
    expect(summary.total).toBe(tasks.length);
    expect(summary.completed).toBe(tasks.filter((t) => t.status === "completed").length);
    expect(summary.remainingMinutes).toBeGreaterThan(0);
  });

  it("excludes completed and skipped time from what's remaining", () => {
    const allDone = buildMockDay(NOW).map((t) => ({ ...t, status: "completed" as const }));
    expect(computeDaySummary(allDone, NOW).remainingMinutes).toBe(0);
  });
});
