import { describe, expect, it, vi } from "vitest";
import { EnvError, getPublicEnv, getVapidPublicKey, isSupabaseConfigured } from "./env.public";

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

describe("getVapidPublicKey", () => {
  it("is null when unset, without throwing (Web Push is optional, like AI)", () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "");
    expect(getVapidPublicKey()).toBeNull();
  });

  it("treats whitespace as unset", () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "   ");
    expect(getVapidPublicKey()).toBeNull();
  });

  it("returns the trimmed value when set", () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", " some-key ");
    expect(getVapidPublicKey()).toBe("some-key");
  });

  it("does not depend on Supabase configuration", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "some-key");
    expect(getVapidPublicKey()).toBe("some-key");
  });
});
