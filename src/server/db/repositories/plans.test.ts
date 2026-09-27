import { describe, expect, it } from "vitest";
import { ExternalServiceError } from "@/server/errors";
import { findPlan, getLatestRevisionNumber } from "./plans";

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
    expect(Object.keys(mod).sort()).toEqual(["findPlan", "getLatestRevisionNumber"]);
  });
});

describe("getLatestRevisionNumber (read-only)", () => {
  /** plans → revisions, recording every call so a write verb would be visible. */
  function fake(plan: unknown, revision: { data: unknown; error: unknown }, seen: string[]) {
    return {
      from(table: string) {
        seen.push(`from:${table}`);
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (c: string, v: string) => (seen.push(`eq:${c}=${v}`), chain),
          order: (c: string, o: { ascending: boolean }) => (
            seen.push(`order:${c}:${o.ascending}`),
            chain
          ),
          limit: (n: number) => (seen.push(`limit:${n}`), chain),
          maybeSingle: async () => (table === "plans" ? { data: plan, error: null } : revision),
        };
        return chain;
      },
    } as never;
  }

  it("reads the newest revision of the day's plan, and only reads", async () => {
    const seen: string[] = [];
    const n = await getLatestRevisionNumber(
      fake({ id: "p1", day_id: "d1" }, { data: { revision_number: 7 }, error: null }, seen),
      "d1",
    );
    expect(n).toBe(7);
    expect(seen).toEqual([
      "from:plans",
      "eq:day_id=d1",
      "from:plan_revisions",
      "eq:plan_id=p1",
      "order:revision_number:false",
      "limit:1",
    ]);
  });
  it("is null with no plan, or a plan with no revision", async () => {
    expect(
      await getLatestRevisionNumber(fake(null, { data: null, error: null }, []), "d1"),
    ).toBeNull();
    expect(
      await getLatestRevisionNumber(
        fake({ id: "p1", day_id: "d1" }, { data: null, error: null }, []),
        "d1",
      ),
    ).toBeNull();
  });
  it("wraps a database failure without leaking it", async () => {
    await expect(
      getLatestRevisionNumber(
        fake(
          { id: "p1", day_id: "d1" },
          { data: null, error: { code: "XX000", message: "secret" } },
          [],
        ),
        "d1",
      ),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });
});
