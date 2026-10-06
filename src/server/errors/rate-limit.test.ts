import { describe, expect, it, vi } from "vitest";
import { RateLimitError, describeWait, errorResponse, runAction, toAppError } from "./index";

vi.mock("@/server/logging/logger", () => {
  const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => log };
  return { logger: log };
});

describe("describeWait", () => {
  it.each([
    [1, "a minute"],
    [60, "a minute"],
    [61, "about 2 minutes"],
    [600, "about 10 minutes"],
    [3599, "about 60 minutes"],
    [3600, "about an hour"],
    [3601, "about 2 hours"],
    [86_400, "about 24 hours"],
  ])("%is → %s (always rounded UP, never telling anyone to return too early)", (seconds, text) => {
    expect(describeWait(seconds)).toBe(text);
  });
  it("falls back safely on nonsense", () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(describeWait(bad)).toBe("a minute");
    }
  });
});

describe("RateLimitError", () => {
  const error = new RateLimitError(900, {
    cause: new Error("SELECT … FROM ai_usage_events — internal"),
  });

  it("is a distinct application error equivalent to HTTP 429", () => {
    expect(error.status).toBe(429);
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.name).toBe("RateLimitError");
    expect(toAppError(error)).toBe(error);
  });

  it("has a safe, fixed message with only a rounded wait — no limit, count, window, SQL or provider text", () => {
    expect(error.message).toBe(
      "You've used your AI allowance for now. Try again in about 15 minutes.",
    );
    expect(error.message).not.toMatch(
      /hour(ly)?\b.*limit|daily|per (hour|day)|\b\d+ (calls|requests)\b|sql|select|supabase|postgres|anthropic|claude|429/i,
    );
  });

  it("is not the provider's own rate-limit classification", async () => {
    const { AiError } = await import("@/server/ai/errors");
    const provider = new AiError("rate_limited");
    expect(provider.message).not.toBe(error.message);
    expect(provider).not.toBeInstanceOf(RateLimitError);
    expect((provider as { code: string }).code).not.toBe(error.code);
  });
});

describe("the existing action / route boundary stays authoritative", () => {
  it("runAction turns it into a normal { ok: false } with the safe message, a request id and no internals", async () => {
    const result = await runAction(async () => {
      throw new RateLimitError(120, { cause: new Error("internal: ai_usage_events") });
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED", message: expect.stringContaining("about 2 minutes") },
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain("ai_usage_events");
    expect(text).not.toContain("retryAfterSeconds");
    expect(Object.keys((result as { error: object }).error).sort()).toEqual([
      "code",
      "message",
      "requestId",
    ]);
  });

  it("errorResponse (route handlers) answers 429 with the same safe payload", async () => {
    const response = errorResponse(new RateLimitError(30, { cause: new Error("internal detail") }));
    expect(response.status).toBe(429);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("RATE_LIMITED");
    expect(body).not.toContain("internal detail");
  });
});
