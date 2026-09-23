import { describe, expect, it, vi } from "vitest";
import { ExternalServiceError } from "@/server/errors";
import { getProfile, saveTimezone } from "./profiles";

describe("getProfile", () => {
  it("returns null — and does not create anything — when no profile exists yet", async () => {
    const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const upsert = vi.fn();
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }), upsert }),
    } as never;

    await expect(getProfile(supabase, "user-1")).resolves.toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("maps a database error to ExternalServiceError without leaking its detail", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: { message: "boom secret" } }),
          }),
        }),
      }),
    } as never;
    const error = await getProfile(supabase, "user-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as Error).message).not.toContain("secret");
  });
});

describe("saveTimezone", () => {
  it("upserts id + timezone on the primary key (profiles has INSERT and UPDATE policies)", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const supabase = { from: () => ({ upsert }) } as never;

    await saveTimezone(supabase, "user-1", "Asia/Calcutta");

    expect(upsert).toHaveBeenCalledWith(
      { id: "user-1", timezone: "Asia/Calcutta" },
      { onConflict: "id" },
    );
  });

  it("maps a database error to ExternalServiceError", async () => {
    const supabase = {
      from: () => ({ upsert: async () => ({ error: { message: "denied" } }) }),
    } as never;
    await expect(saveTimezone(supabase, "user-1", "UTC")).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
  });
});
