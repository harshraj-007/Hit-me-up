import { describe, expect, it } from "vitest";
import { redact, redactString } from "./redact";

describe("redact", () => {
  it("masks sensitive keys at any depth", () => {
    const out = redact({
      userId: "u1",
      apiKey: "abc",
      nested: { Authorization: "Bearer xyz", password: "p", safe: 1 },
      list: [{ token: "t" }],
    });
    expect(out).toEqual({
      userId: "u1",
      apiKey: "[REDACTED]",
      nested: { Authorization: "[REDACTED]", password: "[REDACTED]", safe: 1 },
      list: [{ token: "[REDACTED]" }],
    });
  });

  it("scrubs secret-shaped strings in otherwise innocent fields", () => {
    expect(redactString("failed with sk-ant-api03-AbC_123 and Bearer abc.def")).toBe(
      "failed with [REDACTED] and Bearer [REDACTED]",
    );
  });

  it("handles circular references", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(redact(a)).toEqual({ name: "a", self: "[CIRCULAR]" });
  });
});
