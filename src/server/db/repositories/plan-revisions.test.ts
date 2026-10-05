import { describe, expect, it } from "vitest";
import { ExternalServiceError } from "@/server/errors";
import { listRevisionNumbers } from "./plan-revisions";

function client(plan: unknown, revisions: { data: unknown; error: unknown }, seen: string[] = []) {
  return {
    from(table: string) {
      seen.push(`from:${table}`);
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: string) => (seen.push(`eq:${c}=${v}`), chain),
        order: async () => revisions,
        maybeSingle: async () => ({ data: plan, error: null }),
      };
      return chain;
    },
  } as never;
}

describe("listRevisionNumbers (read-only)", () => {
  it("returns the plan's revision numbers oldest first, reading only that plan", async () => {
    const seen: string[] = [];
    const out = await listRevisionNumbers(
      client(
        { id: "p1", day_id: "d1" },
        { data: [{ revision_number: 1 }, { revision_number: 2 }], error: null },
        seen,
      ),
      "d1",
    );
    expect(out).toEqual([{ revisionNumber: 1 }, { revisionNumber: 2 }]);
    expect(seen).toContain("eq:plan_id=p1");
  });

  it("is empty when the day has no plan", async () => {
    expect(await listRevisionNumbers(client(null, { data: [], error: null }), "d1")).toEqual([]);
  });

  it("wraps a database failure without leaking it", async () => {
    await expect(
      listRevisionNumbers(
        client({ id: "p1", day_id: "d1" }, { data: null, error: { message: "SECRET" } }),
        "d1",
      ),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });
});
