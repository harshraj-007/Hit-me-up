import { describe, expect, it } from "vitest";
import { emailInputSchema } from "./auth";

describe("emailInputSchema", () => {
  it("accepts a valid email", () => {
    expect(emailInputSchema.safeParse({ email: "student@example.com" }).success).toBe(true);
  });

  it("rejects garbage and File values (as FormData.get would return for a mismatched field)", () => {
    expect(emailInputSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
    expect(emailInputSchema.safeParse({ email: null }).success).toBe(false);
  });
});
