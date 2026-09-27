import { describe, expect, it } from "vitest";
import {
  MAX_TASK_DURATION_MS,
  PLANNING_HORIZON_DAYS,
  addDays,
  isPlanDateAllowed,
  lastPlanningDate,
} from "./planning-day";

const TODAY = "2026-09-24";

describe("addDays", () => {
  it("moves across month, year and leap-day boundaries", () => {
    expect(addDays("2026-09-24", 1)).toBe("2026-09-25");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-09-24", -24)).toBe("2026-08-31");
    expect(addDays("2026-09-24", 0)).toBe("2026-09-24");
  });
});

describe("planning horizon: today … today + 365, inclusive (366 dates)", () => {
  it("is defined as 365", () => expect(PLANNING_HORIZON_DAYS).toBe(365));
  it("allows today", () => expect(isPlanDateAllowed(TODAY, TODAY)).toBe(true));
  it("allows tomorrow", () => expect(isPlanDateAllowed("2026-09-25", TODAY)).toBe(true));
  it("allows today + 365, the last date", () => {
    expect(lastPlanningDate(TODAY)).toBe("2027-09-24");
    expect(isPlanDateAllowed("2027-09-24", TODAY)).toBe(true);
  });
  it("rejects today + 366", () => expect(isPlanDateAllowed("2027-09-25", TODAY)).toBe(false));
  it("rejects yesterday and any past date", () => {
    expect(isPlanDateAllowed("2026-09-23", TODAY)).toBe(false);
    expect(isPlanDateAllowed("2020-01-01", TODAY)).toBe(false);
  });
  it("contains exactly 366 allowed dates", () => {
    let allowed = 0;
    for (let n = -5; n <= 370; n++) if (isPlanDateAllowed(addDays(TODAY, n), TODAY)) allowed++;
    expect(allowed).toBe(366);
  });
  it("rejects malformed and impossible dates", () => {
    for (const bad of [
      "",
      "2026-9-25",
      "25-09-2026",
      "2026-02-30",
      "2026-13-01",
      "nonsense",
      "2026-09-25T00:00",
    ]) {
      expect(isPlanDateAllowed(bad, TODAY)).toBe(false);
    }
  });
  it("counts a leap day correctly (the horizon is calendar days, not 365*24h)", () => {
    expect(lastPlanningDate("2027-09-24")).toBe("2028-09-23"); // 2028 is a leap year
  });
});

describe("MAX_TASK_DURATION_MS", () => {
  it("is 24 hours", () => expect(MAX_TASK_DURATION_MS).toBe(86_400_000));
});
