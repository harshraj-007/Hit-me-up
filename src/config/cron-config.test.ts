import { describe, expect, it, vi } from "vitest";
import { getCronSecret, getServiceRoleKey } from "./env.server";

describe("getCronSecret", () => {
  it("is null when unset, without throwing", () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(getCronSecret()).toBeNull();
  });

  it("treats whitespace as unset", () => {
    vi.stubEnv("CRON_SECRET", "   ");
    expect(getCronSecret()).toBeNull();
  });

  it("returns the trimmed value when set", () => {
    vi.stubEnv("CRON_SECRET", " some-secret ");
    expect(getCronSecret()).toBe("some-secret");
  });

  it("does not depend on Supabase or AI configuration", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CRON_SECRET", "some-secret");
    expect(getCronSecret()).toBe("some-secret");
  });
});

describe("getServiceRoleKey", () => {
  it("is null when unset, without throwing", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(getServiceRoleKey()).toBeNull();
  });

  it("treats whitespace as unset", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "   ");
    expect(getServiceRoleKey()).toBeNull();
  });

  it("returns the trimmed value when set, freshly on every call (not cached)", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", " key-one ");
    expect(getServiceRoleKey()).toBe("key-one");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", " key-two ");
    expect(getServiceRoleKey()).toBe("key-two");
  });
});
