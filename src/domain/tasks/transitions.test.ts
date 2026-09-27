import { describe, expect, it } from "vitest";
import { checkTransition, isResolved, isValidTransition, RESOLVED_STATUSES } from "./transitions";
import type { TaskStatus } from "./types";

const ALL: TaskStatus[] = ["upcoming", "completed", "skipped"];

describe("isResolved", () => {
  it("treats completed and skipped as resolved, upcoming as not", () => {
    expect(isResolved("completed")).toBe(true);
    expect(isResolved("skipped")).toBe(true);
    expect(isResolved("upcoming")).toBe(false);
  });

  it("RESOLVED_STATUSES matches isResolved for every status", () => {
    for (const status of ALL) expect(RESOLVED_STATUSES.has(status)).toBe(isResolved(status));
  });
});

describe("isValidTransition", () => {
  it.each([
    ["upcoming", "completed"],
    ["upcoming", "skipped"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(isValidTransition(from, to)).toBe(true);
  });

  it.each([
    ["completed", "upcoming"],
    ["skipped", "upcoming"],
    ["completed", "skipped"],
    ["skipped", "completed"],
    ["completed", "completed"],
  ] as const)("refuses %s -> %s (resolved tasks are terminal)", (from, to) => {
    expect(isValidTransition(from, to)).toBe(false);
  });

  it("has no way to persist 'late' — it is derived from the clock", () => {
    expect(isValidTransition("upcoming", "late" as TaskStatus)).toBe(false);
  });

  it("refuses upcoming -> upcoming", () => {
    expect(isValidTransition("upcoming", "upcoming")).toBe(false);
  });
});

describe("checkTransition", () => {
  it("is ok for a legal transition", () => {
    expect(checkTransition("upcoming", "completed")).toEqual({ ok: true });
  });

  it("explains why a resolved task cannot change", () => {
    const result = checkTransition("completed", "skipped");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already completed/);
  });

  it("explains an illegal target", () => {
    expect(checkTransition("upcoming", "upcoming").ok).toBe(false);
  });
});
