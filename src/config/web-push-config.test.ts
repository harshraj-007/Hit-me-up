import { describe, expect, it, vi } from "vitest";
import { getWebPushConfig } from "./env.server";

const VALID = {
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "test-public-key",
  VAPID_PRIVATE_KEY: "test-private-key",
  VAPID_SUBJECT: "mailto:test@example.test",
};

function stubAll(overrides: Partial<typeof VALID> = {}) {
  const merged = { ...VALID, ...overrides };
  for (const [key, value] of Object.entries(merged)) vi.stubEnv(key, value);
}

describe("getWebPushConfig", () => {
  it("is null when nothing is configured, without throwing", () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "");
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    vi.stubEnv("VAPID_SUBJECT", "");
    expect(getWebPushConfig()).toBeNull();
  });

  it.each([
    ["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "public key"],
    ["VAPID_PRIVATE_KEY", "private key"],
    ["VAPID_SUBJECT", "subject"],
  ])("is null when only %s is missing (never a partial config)", (missingKey) => {
    stubAll({ [missingKey]: "" });
    expect(getWebPushConfig()).toBeNull();
  });

  it("treats whitespace-only values as unset", () => {
    stubAll({ VAPID_PRIVATE_KEY: "   " });
    expect(getWebPushConfig()).toBeNull();
  });

  it("returns the full trimmed config when all three are set — no real production key required", () => {
    stubAll({
      NEXT_PUBLIC_VAPID_PUBLIC_KEY: " pub ",
      VAPID_PRIVATE_KEY: " priv ",
      VAPID_SUBJECT: " mailto:test@example.test ",
    });
    expect(getWebPushConfig()).toEqual({
      publicKey: "pub",
      privateKey: "priv",
      subject: "mailto:test@example.test",
    });
  });

  it("does not depend on Supabase or AI configuration", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    stubAll();
    expect(getWebPushConfig()).toEqual({
      publicKey: VALID.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      privateKey: VALID.VAPID_PRIVATE_KEY,
      subject: VALID.VAPID_SUBJECT,
    });
  });
});
