import { describe, expect, it } from "vitest";
import { checkTransition, isResolved, isValidTransition, RESOLVED_STATUSES } from "./transitions";
import type { TaskStatus } from "./types";

describe("isResolved", () => {
  it("treats completed, skipped and late as resolved", () => {
    expect(isResolved("completed")).toBe(true);
    expect(isResolved("skipped")).toBe(true);
    expect(isResolved("late")).toBe(true);
  });

  it("treats upcoming as not resolved", () => {
    expect(isResolved("upcoming")).toBe(false);
  });

  it("RESOLVED_STATUSES matches isResolved for every status", () => {
    const all: TaskStatus[] = ["upcoming", "completed", "skipped", "late"];
    for (const status of all) {
      expect(RESOLVED_STATUSES.has(status)).toBe(isResolved(status));
    }
  });
});

describe("isValidTransition", () => {
  it.each([
    ["upcoming", "completed"],
    ["upcoming", "skipped"],
    ["upcoming", "late"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(isValidTransition(from, to)).toBe(true);
  });

  it.each([
    ["completed", "upcoming"],
    ["skipped", "upcoming"],
    ["late", "upcoming"],
    ["completed", "skipped"],
    ["skipped", "completed"],
    ["late", "completed"],
  ] as const)("refuses %s -> %s (resolved tasks are terminal)", (from, to) => {
    expect(isValidTransition(from, to)).toBe(false);
  });

  it("refuses a no-op transition to the same status", () => {
    expect(isValidTransition("upcoming", "upcoming")).toBe(false);
  });

  it("never allows a manual transition to a resolved status other than completed/skipped/late", () => {
    // Exhaustive: every (from, to) pair where the transition should be rejected.
    const statuses: TaskStatus[] = ["upcoming", "completed", "skipped", "late"];
    for (const from of statuses) {
      for (const to of statuses) {
        if (from !== "upcoming") {
          expect(isValidTransition(from, to)).toBe(false);
        }
      }
    }
  });
});

describe("checkTransition", () => {
  it("returns ok with no reason for an allowed transition", () => {
    expect(checkTransition("upcoming", "completed")).toEqual({ ok: true });
  });

  it("explains why a resolved task refuses to move", () => {
    const result = checkTransition("completed", "upcoming");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already completed/);
  });
});
