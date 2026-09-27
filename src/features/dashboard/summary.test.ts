import { describe, expect, it } from "vitest";
import { computeRemainingMinutes } from "./summary";
import type { DashboardTask } from "./types";

const win = { start: new Date("2026-09-24T00:00:00Z"), end: new Date("2026-09-25T00:00:00Z") };
const t = (iso: string) => new Date(iso);
const task = (
  start: string,
  end: string,
  status: DashboardTask["status"] = "upcoming",
): DashboardTask => ({
  id: start,
  title: "x",
  start: t(start),
  end: t(end),
  status,
  priority: "medium",
  kind: "flexible",
  locked: false,
  planningDate: "2026-09-24",
  timezone: "UTC",
});

describe("computeRemainingMinutes", () => {
  const now = t("2026-09-24T10:00:00Z");

  it("counts only the part of a task that is still ahead", () => {
    expect(
      computeRemainingMinutes([task("2026-09-24T09:30:00Z", "2026-09-24T10:30:00Z")], now, win),
    ).toBe(30);
    expect(
      computeRemainingMinutes([task("2026-09-24T12:00:00Z", "2026-09-24T13:00:00Z")], now, win),
    ).toBe(60);
  });

  it("ignores resolved, unscheduled and already-late tasks", () => {
    expect(
      computeRemainingMinutes(
        [
          task("2026-09-24T12:00:00Z", "2026-09-24T13:00:00Z", "completed"),
          task("2026-09-24T12:00:00Z", "2026-09-24T13:00:00Z", "skipped"),
          task("2026-09-24T12:00:00Z", "2026-09-24T13:00:00Z", "unscheduled"),
          task("2026-09-24T08:00:00Z", "2026-09-24T09:00:00Z", "late"),
        ],
        now,
        win,
      ),
    ).toBe(0);
  });

  it("clips a cross-midnight task at the day's end: the rest belongs to tomorrow", () => {
    expect(
      computeRemainingMinutes([task("2026-09-24T23:30:00Z", "2026-09-25T01:00:00Z")], now, win),
    ).toBe(30);
  });

  it("counts a previous day's spillover only for the hours it occupies in THIS day", () => {
    const spill = task("2026-09-23T23:30:00Z", "2026-09-24T01:00:00Z");
    expect(computeRemainingMinutes([spill], t("2026-09-24T00:10:00Z"), win)).toBe(50);
  });

  it("for a future day (now is before the window) counts the whole planned duration", () => {
    const future = { start: t("2026-09-26T00:00:00Z"), end: t("2026-09-27T00:00:00Z") };
    expect(
      computeRemainingMinutes([task("2026-09-26T18:00:00Z", "2026-09-26T19:30:00Z")], now, future),
    ).toBe(90);
  });
});
