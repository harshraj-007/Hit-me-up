import { describe, expect, it, vi } from "vitest";
import { AuthenticationError, ExternalServiceError, RateLimitError } from "@/server/errors";
import { reserveAiCall, type AiFeature } from "./ai-usage";

const rpcReturning = (result: { data: unknown; error: unknown }) => {
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => result);
  return { rpc, supabase: { rpc } as never };
};
const ALLOWED = { data: { allowed: true }, error: null };
const DENIED = { data: { allowed: false, window: "hour", retry_after_seconds: 900 }, error: null };

describe("reserveAiCall", () => {
  it.each<AiFeature>(["plan", "briefing_plan", "eod_review"])(
    "sends ONLY the feature name (%s) — never a limit, a user id or any text",
    async (feature) => {
      const { rpc, supabase } = rpcReturning(ALLOWED);
      await reserveAiCall(supabase, feature);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith("reserve_ai_call", { p_feature: feature });
    },
  );

  it("resolves when the database allows the call", async () => {
    await expect(reserveAiCall(rpcReturning(ALLOWED).supabase, "plan")).resolves.toBeUndefined();
  });

  it("throws a RateLimitError (429-equivalent) carrying the wait when the database refuses", async () => {
    const error = await reserveAiCall(rpcReturning(DENIED).supabase, "plan").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ status: 429, code: "RATE_LIMITED", retryAfterSeconds: 900 });
  });

  it("a refusal for the daily window behaves the same", async () => {
    const result = {
      data: { allowed: false, window: "day", retry_after_seconds: 7200 },
      error: null,
    };
    await expect(reserveAiCall(rpcReturning(result).supabase, "eod_review")).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it("no session (42501) is an AuthenticationError with a fixed message", async () => {
    const { supabase } = rpcReturning({
      data: null,
      error: { code: "42501", message: "not authenticated: secret detail" },
    });
    const error = await reserveAiCall(supabase, "plan").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as Error).message).not.toContain("secret detail");
  });

  it.each([
    [
      "a database failure",
      {
        data: null,
        error: { code: "53300", message: "too many connections: postgres://u:pw@h/db" },
      },
    ],
    [
      "an unknown feature (22023)",
      { data: null, error: { code: "22023", message: "unknown AI feature" } },
    ],
    [
      "a missing function",
      {
        data: null,
        error: { code: "PGRST202", message: "Could not find the function public.reserve_ai_call" },
      },
    ],
  ])(
    "FAILS CLOSED on %s — it throws, so the caller makes no model call, and no detail reaches the message",
    async (_label, result) => {
      const error = await reserveAiCall(rpcReturning(result).supabase, "plan").then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ExternalServiceError);
      expect((error as Error).message).not.toMatch(/postgres:|pw@|reserve_ai_call|too many/);
    },
  );

  it.each([
    ["null", null],
    ["an empty object", {}],
    ["allowed as a string", { allowed: "true" }],
    ["an allow with extra fields", { allowed: true, remaining: 3 }],
    ["a refusal missing its wait", { allowed: false, window: "hour" }],
    ["a refusal with a zero wait", { allowed: false, window: "hour", retry_after_seconds: 0 }],
    ["a refusal with a negative wait", { allowed: false, window: "hour", retry_after_seconds: -5 }],
    [
      "a refusal with a fractional wait",
      { allowed: false, window: "hour", retry_after_seconds: 1.5 },
    ],
    [
      "a refusal for an unknown window",
      { allowed: false, window: "week", retry_after_seconds: 60 },
    ],
    ["an array", [{ allowed: true }]],
    ["a bare boolean", true],
  ])("treats an unusable answer (%s) as a failure, NEVER as an allow", async (_label, data) => {
    await expect(
      reserveAiCall(rpcReturning({ data, error: null }).supabase, "plan"),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });
});
