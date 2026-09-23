import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyOtp = vi.fn();
vi.mock("@/server/db/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({ auth: { verifyOtp } })),
}));

import { GET } from "./route";

const ORIGIN = "http://localhost:3000";

/** Builds the request the way a real link would carry it: `next` raw in the query string. */
function confirmRequest(rawNext?: string) {
  const suffix = rawNext === undefined ? "" : `&next=${rawNext}`;
  return new Request(`${ORIGIN}/auth/confirm?token_hash=abc123&type=email${suffix}`);
}

const location = (res: Response) => res.headers.get("location");

describe("GET /auth/confirm — where a verified user is sent", () => {
  beforeEach(() => {
    verifyOtp.mockReset();
    verifyOtp.mockResolvedValue({ error: null });
  });

  it.each([
    ["/today", `${ORIGIN}/today`],
    ["/foo/bar", `${ORIGIN}/foo/bar`],
  ])("?next=%s is allowed", async (next, expected) => {
    expect(location(await GET(confirmRequest(next)))).toBe(expected);
  });

  it("defaults to /today when next is absent", async () => {
    expect(location(await GET(confirmRequest()))).toBe(`${ORIGIN}/today`);
  });

  it.each([
    ["https://evil.example"],
    ["//evil.example"],
    ["/\\evil.example"],
    ["/%09/evil.example"],
    ["javascript:alert(1)"],
  ])("?next=%s is replaced by /today, never followed", async (next) => {
    const res = await GET(confirmRequest(next));
    expect(location(res)).toBe(`${ORIGIN}/today`);
  });

  it("still verifies the token exactly as before — the fix does not touch verification", async () => {
    await GET(confirmRequest("//evil.example"));
    expect(verifyOtp).toHaveBeenCalledExactlyOnceWith({ token_hash: "abc123", type: "email" });
  });

  it("sends a failed verification to /login?error=auth regardless of next", async () => {
    verifyOtp.mockResolvedValue({ error: { name: "AuthApiError", message: "expired" } });
    expect(location(await GET(confirmRequest("/foo/bar")))).toBe(`${ORIGIN}/login?error=auth`);
    expect(location(await GET(confirmRequest("https://evil.example")))).toBe(
      `${ORIGIN}/login?error=auth`,
    );
  });

  it("sends a link with no token to /login?error=auth without calling Supabase", async () => {
    const res = await GET(new Request(`${ORIGIN}/auth/confirm?next=/today`));
    expect(location(res)).toBe(`${ORIGIN}/login?error=auth`);
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});
