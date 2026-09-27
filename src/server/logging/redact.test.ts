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

  it("masks provider secrets and model content by key", () => {
    const out = redact({
      apiKey: "a",
      api_key: "b",
      "x-api-key": "c",
      authorization: "d",
      prompt: "e",
      completion: "f",
      provider: "anthropic",
      latencyMs: 12,
    }) as Record<string, unknown>;
    for (const key of ["apiKey", "api_key", "x-api-key", "authorization", "prompt", "completion"]) {
      expect(out[key]).toBe("[REDACTED]");
    }
    expect(out.provider).toBe("anthropic");
    expect(out.latencyMs).toBe(12);
  });

  it("masks a voice transcript and audio-related fields by key, wherever they appear", () => {
    const out = redact({
      transcript: "move gym after 8pm",
      transcriptText: "move gym after 8pm",
      audioBlob: "base64...",
      audioDurationMs: 4200,
      voice: { transcript: "nested transcript" },
    }) as Record<string, unknown>;
    expect(out.transcript).toBe("[REDACTED]");
    expect(out.transcriptText).toBe("[REDACTED]");
    expect(out.audioBlob).toBe("[REDACTED]");
    expect(out.audioDurationMs).toBe("[REDACTED]"); // "audio" alone is enough to mask the key
    expect((out.voice as Record<string, unknown>).transcript).toBe("[REDACTED]");
  });
});
