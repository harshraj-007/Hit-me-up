import { describe, expect, it, vi } from "vitest";
import { EnvError, getPublicEnv, isSupabaseConfigured } from "./env.public";

describe("public env", () => {
  it("reports missing variable names without echoing values", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect(isSupabaseConfigured()).toBe(false);
    expect(() => getPublicEnv()).toThrow(EnvError);
    expect(() => getPublicEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("parses a valid configuration", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    expect(getPublicEnv().NEXT_PUBLIC_SUPABASE_URL).toBe("https://example.supabase.co");
  });
});
