import { describe, expect, it } from "vitest";
import { dayBoundsUtc, localMidnightUtc, wallTimeToUtc } from "./bounds";

const hours = (b: { start: Date; end: Date }) => (b.end.getTime() - b.start.getTime()) / 3_600_000;

describe("dayBoundsUtc", () => {
  it("is exactly UTC midnight to midnight in UTC", () => {
    const b = dayBoundsUtc("2026-09-22", "UTC");
    expect(b.start.toISOString()).toBe("2026-09-22T00:00:00.000Z");
    expect(b.end.toISOString()).toBe("2026-09-23T00:00:00.000Z");
  });

  it("handles a half-hour offset east of UTC (Asia/Kolkata, +05:30)", () => {
    const b = dayBoundsUtc("2026-09-22", "Asia/Kolkata");
    expect(b.start.toISOString()).toBe("2026-09-21T18:30:00.000Z");
    expect(b.end.toISOString()).toBe("2026-09-22T18:30:00.000Z");
  });

  it("handles a zone west of UTC (America/Los_Angeles, PDT -07:00 in September)", () => {
    const b = dayBoundsUtc("2026-09-22", "America/Los_Angeles");
    expect(b.start.toISOString()).toBe("2026-09-22T07:00:00.000Z");
    expect(b.end.toISOString()).toBe("2026-09-23T07:00:00.000Z");
  });

  it("handles the largest positive offset (Pacific/Kiritimati, +14:00)", () => {
    expect(dayBoundsUtc("2026-09-22", "Pacific/Kiritimati").start.toISOString()).toBe(
      "2026-09-21T10:00:00.000Z",
    );
  });

  it("is 23 hours long on the spring-forward day", () => {
    const b = dayBoundsUtc("2026-03-08", "America/Los_Angeles");
    expect(b.start.toISOString()).toBe("2026-03-08T08:00:00.000Z"); // PST -08:00
    expect(b.end.toISOString()).toBe("2026-03-09T07:00:00.000Z"); // PDT -07:00
    expect(hours(b)).toBe(23);
  });

  it("is 25 hours long on the fall-back day", () => {
    const b = dayBoundsUtc("2026-11-01", "America/Los_Angeles");
    expect(b.start.toISOString()).toBe("2026-11-01T07:00:00.000Z"); // PDT -07:00
    expect(b.end.toISOString()).toBe("2026-11-02T08:00:00.000Z"); // PST -08:00
    expect(hours(b)).toBe(25);
  });

  it("rolls the end over month and year boundaries", () => {
    expect(dayBoundsUtc("2026-12-31", "UTC").end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(dayBoundsUtc("2028-02-28", "UTC").end.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("agrees with resolveLocalDate at both edges", async () => {
    const { resolveLocalDate } = await import("./timezone");
    for (const tz of ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Auckland"]) {
      const b = dayBoundsUtc("2026-10-04", tz);
      expect(resolveLocalDate(b.start, tz)).toBe("2026-10-04");
      expect(resolveLocalDate(new Date(b.start.getTime() - 1), tz)).toBe("2026-10-03");
      expect(resolveLocalDate(new Date(b.end.getTime() - 1), tz)).toBe("2026-10-04");
      expect(resolveLocalDate(b.end, tz)).toBe("2026-10-05");
    }
  });
});

describe("localMidnightUtc", () => {
  it("returns the start of the given local date", () => {
    expect(localMidnightUtc("2026-09-22", "Asia/Kolkata").toISOString()).toBe(
      "2026-09-21T18:30:00.000Z",
    );
  });
});

describe("wallTimeToUtc", () => {
  const w = (date: string, time: string, timezone: string) =>
    wallTimeToUtc({ date, time, timezone }).toISOString();

  it("maps an ordinary time to exactly one instant", () => {
    expect(w("2026-09-22", "18:00", "Asia/Kolkata")).toBe("2026-09-22T12:30:00.000Z");
    expect(w("2026-09-22", "18:00", "America/Los_Angeles")).toBe("2026-09-23T01:00:00.000Z");
    expect(w("2026-09-22", "23:59", "UTC")).toBe("2026-09-22T23:59:00.000Z");
  });

  it("spring forward: a nonexistent 02:30 moves FORWARD by the gap (to 03:30 PDT)", () => {
    expect(w("2026-03-08", "02:30", "America/Los_Angeles")).toBe("2026-03-08T10:30:00.000Z");
    expect(w("2026-03-08", "02:00", "America/Los_Angeles")).toBe("2026-03-08T10:00:00.000Z");
    // Times either side of the gap are untouched.
    expect(w("2026-03-08", "01:59", "America/Los_Angeles")).toBe("2026-03-08T09:59:00.000Z");
    expect(w("2026-03-08", "03:00", "America/Los_Angeles")).toBe("2026-03-08T10:00:00.000Z");
  });

  it("fall back: an ambiguous 01:30 resolves to its FIRST occurrence (PDT)", () => {
    expect(w("2026-11-01", "01:30", "America/Los_Angeles")).toBe("2026-11-01T08:30:00.000Z");
    // …and unambiguous neighbours are unchanged.
    expect(w("2026-11-01", "00:59", "America/Los_Angeles")).toBe("2026-11-01T07:59:00.000Z");
    expect(w("2026-11-01", "02:00", "America/Los_Angeles")).toBe("2026-11-01T10:00:00.000Z");
  });

  it("a half-hour DST zone (Australia/Lord_Howe) still resolves its gap and overlap", () => {
    // Lord Howe springs forward 02:00 → 02:30 on 2026-10-04 (+10:30 → +11:00).
    expect(w("2026-10-04", "02:15", "Australia/Lord_Howe")).toBe("2026-10-03T15:45:00.000Z");
  });
});

describe("day bounds around a DST change that happens AT midnight", () => {
  it("spring forward at 00:00 (America/Havana, 2026-03-08): the day starts at 01:00 local", () => {
    const b = dayBoundsUtc("2026-03-08", "America/Havana");
    expect(b.start.toISOString()).toBe("2026-03-08T05:00:00.000Z"); // 01:00 CDT (-04:00)
    expect(hours(b)).toBe(23);
    // The previous day therefore ends at exactly that instant, with no gap and no overlap.
    expect(dayBoundsUtc("2026-03-07", "America/Havana").end.toISOString()).toBe(
      b.start.toISOString(),
    );
  });

  it("fall back to 00:00 (America/Havana, 2026-11-01): midnight is ambiguous → first occurrence", () => {
    const b = dayBoundsUtc("2026-11-01", "America/Havana");
    expect(b.start.toISOString()).toBe("2026-11-01T04:00:00.000Z"); // 00:00 CDT (-04:00)
    expect(hours(b)).toBe(25);
  });

  it("Asia/Beirut (spring forward at 00:00) also starts its day at the first instant that exists", async () => {
    const { resolveLocalDate } = await import("./timezone");
    const b = dayBoundsUtc("2026-03-29", "Asia/Beirut");
    expect(resolveLocalDate(b.start, "Asia/Beirut")).toBe("2026-03-29");
    expect(resolveLocalDate(new Date(b.start.getTime() - 1), "Asia/Beirut")).toBe("2026-03-28");
  });
});
