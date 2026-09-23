import { describe, expect, it } from "vitest";
import { BRIEFING_MAX_LENGTH, createBriefingInputSchema } from "./briefing";

describe("createBriefingInputSchema", () => {
  it("accepts non-empty text and trims it", () => {
    const result = createBriefingInputSchema.safeParse({ rawText: "  hello  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.rawText).toBe("hello");
  });

  it("rejects empty or whitespace-only text", () => {
    expect(createBriefingInputSchema.safeParse({ rawText: "" }).success).toBe(false);
    expect(createBriefingInputSchema.safeParse({ rawText: "   " }).success).toBe(false);
  });

  it("rejects text over the max length", () => {
    expect(
      createBriefingInputSchema.safeParse({ rawText: "a".repeat(BRIEFING_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });
});
