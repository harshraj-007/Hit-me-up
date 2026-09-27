import { describe, expect, it, vi } from "vitest";
import { getAiConfig } from "./env.server";

describe("getAiConfig", () => {
  it("is null when nothing is configured, without throwing", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    expect(getAiConfig()).toBeNull();
  });
  it("is null when only one of the two is set (never a partial config)", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    expect(getAiConfig()).toBeNull();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_MODEL", "m");
    expect(getAiConfig()).toBeNull();
  });
  it("treats whitespace as unset", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "   ");
    vi.stubEnv("ANTHROPIC_MODEL", "m");
    expect(getAiConfig()).toBeNull();
  });
  it("returns both values when set", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", " sk-test ");
    vi.stubEnv("ANTHROPIC_MODEL", "some-model");
    expect(getAiConfig()).toEqual({ apiKey: "sk-test", model: "some-model" });
  });
  it("does not depend on Supabase configuration", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    vi.stubEnv("ANTHROPIC_MODEL", "m");
    expect(getAiConfig()).toEqual({ apiKey: "k", model: "m" });
  });
});
