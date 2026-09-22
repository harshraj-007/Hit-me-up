import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatDayHeading,
  formatDuration,
  formatRange,
  isNow,
  isToday,
  minutesBetween,
} from "./time";

const at = (h: number, m: number) => new Date(2026, 8, 22, h, m);

describe("formatClock", () => {
  it("formats a 12-hour clock time", () => {
    expect(formatClock(at(9, 5))).toBe("9:05 AM");
    expect(formatClock(at(13, 30))).toBe("1:30 PM");
  });
});

describe("formatRange", () => {
  it("drops the repeated period when both ends share it", () => {
    expect(formatRange(at(9, 0), at(9, 30))).toBe("9:00 – 9:30 AM");
  });

  it("keeps both periods when the range crosses noon", () => {
    expect(formatRange(at(11, 30), at(12, 15))).toBe("11:30 AM – 12:15 PM");
  });
});

describe("formatDuration", () => {
  it.each([
    [30, "30m"],
    [60, "1h"],
    [90, "1h 30m"],
    [0, "0m"],
  ])("%i minutes -> %s", (minutes, expected) => {
    expect(formatDuration(minutes)).toBe(expected);
  });
});

describe("minutesBetween / isNow / isToday", () => {
  it("computes minutes between two times", () => {
    expect(minutesBetween(at(9, 0), at(10, 15))).toBe(75);
  });

  it("isNow is inclusive of the boundaries", () => {
    const start = at(9, 0);
    const end = at(10, 0);
    expect(isNow(start, end, at(9, 30))).toBe(true);
    expect(isNow(start, end, start)).toBe(true);
    expect(isNow(start, end, at(10, 1))).toBe(false);
  });

  it("isToday compares calendar day, not time", () => {
    expect(isToday(at(0, 1), at(23, 59))).toBe(true);
    expect(isToday(new Date(2026, 8, 21), at(0, 0))).toBe(false);
  });
});

describe("formatDayHeading", () => {
  it("reads as a full weekday + month + day", () => {
    expect(formatDayHeading(at(9, 0))).toBe("Tuesday, September 22");
  });
});
