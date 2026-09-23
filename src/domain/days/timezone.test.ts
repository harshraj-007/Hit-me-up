import { describe, expect, it } from "vitest";
import { isValidTimeZone, resolveLocalDate } from "./timezone";

describe("resolveLocalDate", () => {
  it("returns YYYY-MM-DD for UTC", () => {
    expect(resolveLocalDate(new Date("2026-09-22T15:00:00Z"), "UTC")).toBe("2026-09-22");
  });

  it("crosses the calendar date boundary correctly for a positive-offset zone", () => {
    // 23:30 in Tokyo (UTC+9) on the 22nd is still the 22nd there, even though it's already
    // 14:30 UTC — the whole point of resolving in the user's own zone, not UTC's.
    expect(resolveLocalDate(new Date("2026-09-22T14:30:00Z"), "Asia/Tokyo")).toBe("2026-09-22");
    expect(resolveLocalDate(new Date("2026-09-22T15:30:00Z"), "Asia/Tokyo")).toBe("2026-09-23");
  });

  it("crosses the calendar date boundary correctly for a negative-offset zone", () => {
    // 19:00 UTC on the 22nd is still 15:00 on the 22nd in New York (UTC-4 in September),
    // but by 04:00 UTC on the 23rd it's already 00:00 on the 23rd there.
    expect(resolveLocalDate(new Date("2026-09-22T19:00:00Z"), "America/New_York")).toBe(
      "2026-09-22",
    );
    expect(resolveLocalDate(new Date("2026-09-23T04:00:00Z"), "America/New_York")).toBe(
      "2026-09-23",
    );
  });

  it("gives two users in different zones a different 'today' for the same instant", () => {
    const instant = new Date("2026-09-23T02:00:00Z");
    expect(resolveLocalDate(instant, "Asia/Tokyo")).toBe("2026-09-23");
    expect(resolveLocalDate(instant, "America/Los_Angeles")).toBe("2026-09-22");
  });
});

describe("isValidTimeZone", () => {
  it("accepts real IANA names", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
  });

  it("rejects garbage", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
