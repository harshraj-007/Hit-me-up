import { describe, expect, it } from "vitest";
import { deriveTaskTemporalState } from "./temporal";
import type { Task } from "./types";

const START = new Date("2026-09-22T09:00:00.000Z");
const END = new Date("2026-09-22T09:30:00.000Z");
const at = (iso: string) => new Date(iso);

const task = (overrides: Partial<Pick<Task, "status" | "unscheduled">> = {}) => ({
  status: "upcoming" as Task["status"],
  unscheduled: false,
  scheduledStart: START,
  scheduledEnd: END,
  ...overrides,
});

describe("deriveTaskTemporalState — half-open [start, end)", () => {
  it("is upcoming before the start", () => {
    expect(deriveTaskTemporalState(task(), at("2026-09-22T08:59:59.999Z"))).toBe("upcoming");
  });

  it("is current exactly at the start", () => {
    expect(deriveTaskTemporalState(task(), START)).toBe("current");
  });

  it("is current during the task and 1ms before the end", () => {
    expect(deriveTaskTemporalState(task(), at("2026-09-22T09:15:00.000Z"))).toBe("current");
    expect(deriveTaskTemporalState(task(), at("2026-09-22T09:29:59.999Z"))).toBe("current");
  });

  it("is late exactly at the end (the end is exclusive)", () => {
    expect(deriveTaskTemporalState(task(), END)).toBe("late");
  });

  it("is late after the end", () => {
    expect(deriveTaskTemporalState(task(), at("2026-09-22T18:00:00.000Z"))).toBe("late");
  });

  it("hands over at the shared boundary of back-to-back tasks: never two current at once", () => {
    const next = { ...task(), scheduledStart: END, scheduledEnd: at("2026-09-22T10:00:00.000Z") };
    expect(deriveTaskTemporalState(task(), END)).toBe("late");
    expect(deriveTaskTemporalState(next, END)).toBe("current");
  });
});

describe("deriveTaskTemporalState — stored states win", () => {
  it.each(["completed", "skipped"] as const)("%s stays %s at any time", (status) => {
    for (const iso of ["2026-09-22T08:00:00Z", "2026-09-22T09:10:00Z", "2026-09-22T12:00:00Z"]) {
      expect(deriveTaskTemporalState(task({ status }), at(iso))).toBe(status);
    }
  });

  it("an unscheduled task is unscheduled whatever the clock says", () => {
    for (const iso of ["2026-09-22T08:00:00Z", "2026-09-22T09:10:00Z", "2026-09-22T12:00:00Z"]) {
      expect(deriveTaskTemporalState(task({ unscheduled: true }), at(iso))).toBe("unscheduled");
    }
  });

  it("a resolved task is never shown as unscheduled", () => {
    expect(deriveTaskTemporalState(task({ status: "completed", unscheduled: true }), START)).toBe(
      "completed",
    );
  });
});

describe("deriveTaskTemporalState — a window that crosses midnight (Thu 23:30 → Fri 01:00)", () => {
  const cross = {
    status: "upcoming" as const,
    unscheduled: false,
    scheduledStart: new Date("2026-09-24T23:30:00.000Z"),
    scheduledEnd: new Date("2026-09-25T01:00:00.000Z"),
  };
  const state = (iso: string) => deriveTaskTemporalState(cross, new Date(iso));

  it("is upcoming before it starts", () =>
    expect(state("2026-09-24T23:29:59.999Z")).toBe("upcoming"));
  it("is current from its start, through midnight, up to 1ms before the end", () => {
    expect(state("2026-09-24T23:30:00.000Z")).toBe("current");
    expect(state("2026-09-24T23:59:59.999Z")).toBe("current");
    expect(state("2026-09-25T00:00:00.000Z")).toBe("current");
    expect(state("2026-09-25T00:59:59.999Z")).toBe("current");
  });
  it("is late exactly at the end and after (half-open)", () => {
    expect(state("2026-09-25T01:00:00.000Z")).toBe("late");
    expect(state("2026-09-25T09:00:00.000Z")).toBe("late");
  });
});
