import { describe, expect, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ marker: "client" })) }));

import { createClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "./supabase-service-role";

describe("createSupabaseServiceRoleClient", () => {
  it("is null when SUPABASE_SERVICE_ROLE_KEY is unset — the same graceful degradation as every other optional config", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    expect(createSupabaseServiceRoleClient()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("constructs a client with the service-role key, never the anon key, and no session persistence", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-secret");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");

    createSupabaseServiceRoleClient();

    expect(createClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "service-role-secret",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  });
});
