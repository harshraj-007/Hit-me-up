import { describe, expect, it } from "vitest";
import { localDateSchema, timezoneSchema } from "./day";

describe("localDateSchema", () => {
  it("accepts YYYY-MM-DD", () => {
    expect(localDateSchema.safeParse("2026-09-22").success).toBe(true);
  });

  it("rejects a full timestamp or garbage", () => {
    expect(localDateSchema.safeParse("2026-09-22T00:00:00Z").success).toBe(false);
    expect(localDateSchema.safeParse("not-a-date").success).toBe(false);
  });
});

describe("timezoneSchema", () => {
  it("accepts a plausible IANA-shaped string", () => {
    expect(timezoneSchema.safeParse("America/New_York").success).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(timezoneSchema.safeParse("").success).toBe(false);
  });
});
