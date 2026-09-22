import { describe, expect, it, vi } from "vitest";
import { getHealthReport } from "./health";

function configure() {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key-value");
  vi.stubEnv("LOG_LEVEL", "silent");
}

describe("getHealthReport", () => {
  it("is degraded when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect((await getHealthReport()).status).toBe("degraded");
  });

  it("is ok when the database probe succeeds, sending only the anon key", async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const report = await getHealthReport();
    expect(report).toMatchObject({ status: "ok", checks: { database: "ok" } });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://example.supabase.co/auth/v1/health");
  });

  it("is down and leaks no error detail when the probe fails", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5")));
    const report = await getHealthReport();
    expect(report.status).toBe("down");
    expect(Object.keys(report).sort()).toEqual(["checks", "status", "timestamp"]);
    expect(JSON.stringify(report)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|anon-key-value/);
  });
});
