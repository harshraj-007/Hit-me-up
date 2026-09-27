import { describe, expect, it } from "vitest";
import { formatLocalWallTime, parseLocalWallTime } from "./local-time";

describe("local wall time", () => {
  it("round-trips in a non-UTC zone", () => {
    const instant = parseLocalWallTime("2026-10-01T20:00", "America/New_York")!;
    expect(instant.toISOString()).toBe("2026-10-02T00:00:00.000Z");
    expect(formatLocalWallTime(instant, "America/New_York")).toBe("2026-10-01T20:00");
  });
  it("formats midnight as 00:00, not 24:00", () => {
    expect(formatLocalWallTime(new Date("2026-10-02T00:00:00Z"), "UTC")).toBe("2026-10-02T00:00");
  });
  it.each([
    "2026-02-30T10:00",
    "2026-10-01T24:00",
    "2026-10-01T10:60",
    "2026-10-01 10:00",
    "2026-10-01T10:00:00Z",
    "tomorrow at 8",
    "",
    "2026-13-01T10:00",
  ])("rejects %j", (value) => {
    expect(parseLocalWallTime(value, "UTC")).toBeNull();
  });
});
