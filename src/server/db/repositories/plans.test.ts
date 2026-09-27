import { describe, expect, it } from "vitest";
import { ExternalServiceError } from "@/server/errors";
import { findPlan } from "./plans";

function fakeSupabase(result: { data: unknown; error: unknown }, seen: string[] = []) {
  return {
    from(table: string) {
      seen.push(`from:${table}`);
      const chain = {
        select: () => chain,
        eq: (column: string, value: string) => {
          seen.push(`eq:${column}=${value}`);
          return chain;
        },
        maybeSingle: async () => result,
      };
      return chain;
    },
  } as never;
}

describe("findPlan (read-only)", () => {
  it("maps the row, querying only by day id", async () => {
    const seen: string[] = [];
    const plan = await findPlan(
      fakeSupabase({ data: { id: "p1", day_id: "d1" }, error: null }, seen),
      "d1",
    );
    expect(plan).toEqual({ id: "p1", dayId: "d1" });
    expect(seen).toEqual(["from:plans", "eq:day_id=d1"]);
  });

  it("returns null when the day has no plan", async () => {
    expect(await findPlan(fakeSupabase({ data: null, error: null }), "d1")).toBeNull();
  });

  it("wraps a database failure without leaking it", async () => {
    await expect(
      findPlan(
        fakeSupabase({ data: null, error: { code: "XX000", message: "secret detail" } }),
        "d1",
      ),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("exposes no write path: plans and revisions are created only by ensure_day()", async () => {
    const mod = await import("./plans");
    expect(Object.keys(mod)).toEqual(["findPlan"]);
  });
});
