import { describe, expect, it } from "vitest";
import {
  crossesMidnight,
  formatClock,
  localDateOf,
  formatDayHeading,
  formatDuration,
  formatPlanningDate,
  formatRange,
  formatTimeInput,
  formatWindow,
  localHour,
  minutesBetween,
} from "./time";

const IST = "Asia/Kolkata";
const LA = "America/Los_Angeles";
/** 09:05 in Kolkata on Tue 22 Sep 2026. */
const at = (iso: string) => new Date(iso);

describe("formatClock (explicit timezone)", () => {
  it("formats a 12-hour clock time in the given zone, not the machine's", () => {
    expect(formatClock(at("2026-09-22T03:35:00Z"), IST)).toBe("9:05 AM");
    expect(formatClock(at("2026-09-22T08:00:00Z"), IST)).toBe("1:30 PM");
    expect(formatClock(at("2026-09-22T03:35:00Z"), LA)).toBe("8:35 PM");
  });

  it("uses a plain space before AM/PM and handles midnight and noon", () => {
    expect(formatClock(at("2026-09-22T18:30:00Z"), IST)).toBe("12:00 AM");
    expect(formatClock(at("2026-09-22T06:30:00Z"), IST)).toBe("12:00 PM");
    expect(formatClock(at("2026-09-22T06:30:00Z"), IST)).not.toMatch(/ /);
  });
});

describe("formatRange", () => {
  it("drops the repeated period when both ends share it", () => {
    expect(formatRange(at("2026-09-22T03:30:00Z"), at("2026-09-22T04:00:00Z"), IST)).toBe(
      "9:00 – 9:30 AM",
    );
  });
  it("keeps both periods when the range crosses noon", () => {
    expect(formatRange(at("2026-09-22T06:00:00Z"), at("2026-09-22T06:45:00Z"), IST)).toBe(
      "11:30 AM – 12:15 PM",
    );
  });
});

describe("formatWindow — +1 day", () => {
  it("adds no suffix inside one local day", () => {
    expect(formatWindow(at("2026-09-22T03:30:00Z"), at("2026-09-22T04:00:00Z"), IST)).toBe(
      "9:00 – 9:30 AM",
    );
  });

  it("shows '+1 day' when the end is on the following LOCAL date: 23:30 – 01:00", () => {
    // 23:30 → 01:00 in Kolkata is 18:00Z → 19:30Z.
    expect(formatWindow(at("2026-09-22T18:00:00Z"), at("2026-09-22T19:30:00Z"), IST)).toBe(
      "11:30 PM – 1:00 AM +1 day",
    );
  });

  it("decides by the day's zone: the same instants are the SAME local day elsewhere", () => {
    expect(formatWindow(at("2026-09-22T18:00:00Z"), at("2026-09-22T19:30:00Z"), LA)).not.toContain(
      "+1 day",
    );
  });

  it("an exactly-24h window ends on the next local date", () => {
    expect(formatWindow(at("2026-09-22T18:00:00Z"), at("2026-09-23T18:00:00Z"), IST)).toContain(
      "+1 day",
    );
  });

  it("works across a DST change (23h day in Los Angeles)", () => {
    // Sun 2026-03-08 23:30 PDT → Mon 00:30 PDT.
    expect(formatWindow(at("2026-03-09T06:30:00Z"), at("2026-03-09T07:30:00Z"), LA)).toBe(
      "11:30 PM – 12:30 AM +1 day",
    );
  });
});

describe("formatDuration / minutesBetween", () => {
  it.each([
    [30, "30m"],
    [60, "1h"],
    [90, "1h 30m"],
    [0, "0m"],
  ])("%i minutes -> %s", (minutes, expected) => {
    expect(formatDuration(minutes)).toBe(expected);
  });

  it("computes minutes between two times", () => {
    expect(minutesBetween(at("2026-09-22T09:00:00Z"), at("2026-09-22T10:15:00Z"))).toBe(75);
  });
});

describe("day heading, planning date, hour and input value", () => {
  it("formatDayHeading reads as weekday + month + day in the zone", () => {
    expect(formatDayHeading(at("2026-09-22T03:35:00Z"), IST)).toBe("Tuesday, September 22");
    expect(formatDayHeading(at("2026-09-22T03:35:00Z"), LA)).toBe("Monday, September 21");
  });

  it("formatPlanningDate renders a plain calendar date", () => {
    expect(formatPlanningDate("2026-09-26")).toBe("Sat 26 Sep");
    expect(formatPlanningDate("2027-01-01")).toBe("Fri 1 Jan");
  });

  it("localHour reads the wall clock of the given zone", () => {
    expect(localHour(at("2026-09-22T03:35:00Z"), IST)).toBe(9);
    expect(localHour(at("2026-09-22T18:30:00Z"), IST)).toBe(0);
  });

  it("formatTimeInput gives a zero-padded 24h value", () => {
    expect(formatTimeInput(at("2026-09-22T03:35:00Z"), IST)).toBe("09:05");
    expect(formatTimeInput(at("2026-09-22T18:30:00Z"), IST)).toBe("00:00");
    expect(formatTimeInput(at("2026-09-22T19:30:00Z"), IST)).toBe("01:00");
  });
});

describe("localDateOf / crossesMidnight", () => {
  it("reads the calendar date in the given zone", () => {
    expect(localDateOf(at("2026-09-22T18:30:00Z"), IST)).toBe("2026-09-23");
    expect(localDateOf(at("2026-09-22T18:30:00Z"), "UTC")).toBe("2026-09-22");
  });
  it("crossesMidnight is decided by the local date, not by 24h", () => {
    expect(crossesMidnight(at("2026-09-22T18:00:00Z"), at("2026-09-22T19:30:00Z"), IST)).toBe(true);
    expect(crossesMidnight(at("2026-09-22T03:00:00Z"), at("2026-09-22T04:00:00Z"), IST)).toBe(
      false,
    );
    expect(crossesMidnight(at("2026-09-22T18:00:00Z"), at("2026-09-22T19:30:00Z"), "UTC")).toBe(
      false,
    );
  });
});
