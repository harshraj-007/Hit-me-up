import { describe, expect, it } from "vitest";
import { validateTaskWindow } from "./window";

// Thursday 2026-09-24 in UTC.
const bounds = {
  start: new Date("2026-09-24T00:00:00.000Z"),
  end: new Date("2026-09-25T00:00:00.000Z"),
};
const at = (iso: string) => new Date(iso);
const check = (s: string, e: string) => validateTaskWindow(at(s), at(e), bounds);

describe("validateTaskWindow", () => {
  it("accepts an ordinary same-day window", () => {
    expect(check("2026-09-24T00:00:00Z", "2026-09-24T23:00:00Z")).toEqual({ ok: true });
  });

  it("accepts a start exactly at dayStart", () => {
    expect(check("2026-09-24T00:00:00.000Z", "2026-09-24T01:00:00.000Z").ok).toBe(true);
  });

  it("accepts a start 1ms before dayEnd", () => {
    expect(check("2026-09-24T23:59:59.999Z", "2026-09-25T00:30:00.000Z").ok).toBe(true);
  });

  it("rejects a start exactly at dayEnd (that is the next planning day)", () => {
    expect(check("2026-09-25T00:00:00.000Z", "2026-09-25T01:00:00.000Z").ok).toBe(false);
  });

  it("rejects a start 1ms before dayStart", () => {
    expect(check("2026-09-23T23:59:59.999Z", "2026-09-24T01:00:00.000Z").ok).toBe(false);
  });

  it.each([
    ["Thu 23:30 → Fri 01:00", "2026-09-24T23:30:00Z", "2026-09-25T01:00:00Z", true],
    ["Thu 23:30 → Fri 23:30 (exactly 24h)", "2026-09-24T23:30:00Z", "2026-09-25T23:30:00Z", true],
    ["Thu 23:30 → Sat 00:00 (24h30)", "2026-09-24T23:30:00Z", "2026-09-26T00:00:00Z", false],
    [
      "Fri 00:00 → Fri 01:00 for a Thursday task",
      "2026-09-25T00:00:00Z",
      "2026-09-25T01:00:00Z",
      false,
    ],
    ["Thu 00:00 → Thu 23:00", "2026-09-24T00:00:00Z", "2026-09-24T23:00:00Z", true],
  ])("spec example: %s", (_label, s, e, ok) => {
    expect(check(s, e).ok).toBe(ok);
  });

  it("accepts exactly 24h and rejects 24h + 1ms", () => {
    expect(check("2026-09-24T10:00:00.000Z", "2026-09-25T10:00:00.000Z").ok).toBe(true);
    expect(check("2026-09-24T10:00:00.000Z", "2026-09-25T10:00:00.001Z").ok).toBe(false);
  });

  it("rejects end equal to start and end before start", () => {
    expect(check("2026-09-24T10:00:00Z", "2026-09-24T10:00:00Z").ok).toBe(false);
    expect(check("2026-09-24T10:00:00Z", "2026-09-24T09:00:00Z").ok).toBe(false);
  });

  it("rejects invalid timestamps", () => {
    expect(validateTaskWindow(new Date("nope"), at("2026-09-24T10:00:00Z"), bounds).ok).toBe(false);
    expect(validateTaskWindow(at("2026-09-24T10:00:00Z"), new Date("nope"), bounds).ok).toBe(false);
  });

  it("works on a 23-hour DST day using the day's real bounds", () => {
    const dst = { start: new Date("2026-03-08T08:00:00Z"), end: new Date("2026-03-09T07:00:00Z") };
    expect(
      validateTaskWindow(
        new Date("2026-03-09T06:59:59.999Z"),
        new Date("2026-03-09T08:00:00Z"),
        dst,
      ).ok,
    ).toBe(true);
    expect(
      validateTaskWindow(new Date("2026-03-09T07:00:00Z"), new Date("2026-03-09T08:00:00Z"), dst)
        .ok,
    ).toBe(false);
  });
});
