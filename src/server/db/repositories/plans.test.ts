import { describe, expect, it } from "vitest";
import { ExternalServiceError } from "@/server/errors";
import { ensurePlan } from "./plans";

interface State {
  plan: { id: string; day_id: string } | null;
  revisions: number;
}

interface Call {
  op: "select" | "upsert";
  table: string;
  opts?: Record<string, unknown>;
}

/** Minimal recording stand-in for the query builder paths ensurePlan uses. */
function fakeSupabase(state: State, failUpsertOn?: string) {
  const calls: Call[] = [];
  const supabase = {
    from(table: string) {
      const chain = {
        select() {
          return chain;
        },
        eq() {
          return chain;
        },
        limit() {
          return chain;
        },
        async maybeSingle() {
          calls.push({ op: "select", table });
          if (table === "plans") return { data: state.plan, error: null };
          return { data: state.revisions > 0 ? { id: "rev-1" } : null, error: null };
        },
        async upsert(row: Record<string, string>, opts: Record<string, unknown>) {
          calls.push({ op: "upsert", table, opts });
          if (table === failUpsertOn) return { error: { code: "42501", message: "denied" } };
          if (table === "plans") state.plan = { id: "plan-1", day_id: row.day_id! };
          else state.revisions += 1;
          return { error: null };
        },
      };
      return chain;
    },
  };
  return { supabase: supabase as never, calls };
}

const writes = (calls: Call[]) => calls.filter((c) => c.op === "upsert");

describe("ensurePlan", () => {
  it("performs no writes when the plan and its revision already exist (a refresh)", async () => {
    const { supabase, calls } = fakeSupabase({
      plan: { id: "plan-1", day_id: "day-1" },
      revisions: 1,
    });
    await expect(ensurePlan(supabase, "user-1", "day-1")).resolves.toEqual({
      id: "plan-1",
      dayId: "day-1",
    });
    expect(writes(calls)).toHaveLength(0);
  });

  it("creates the plan and revision 1 on first open, and is a no-op the second time", async () => {
    const state: State = { plan: null, revisions: 0 };
    const first = fakeSupabase(state);
    await ensurePlan(first.supabase, "user-1", "day-1");
    expect(writes(first.calls).map((c) => c.table)).toEqual(["plans", "plan_revisions"]);
    expect(state.revisions).toBe(1);

    const second = fakeSupabase(state);
    await ensurePlan(second.supabase, "user-1", "day-1");
    expect(writes(second.calls)).toHaveLength(0);
    expect(state.revisions).toBe(1);
  });

  it("repairs a plan that was left without a revision, writing only the revision", async () => {
    const state: State = { plan: { id: "plan-1", day_id: "day-1" }, revisions: 0 };
    const { supabase, calls } = fakeSupabase(state);
    await ensurePlan(supabase, "user-1", "day-1");
    expect(writes(calls).map((c) => c.table)).toEqual(["plan_revisions"]);
    expect(state.revisions).toBe(1);
  });

  // Regression: `.upsert({ onConflict })` without ignoreDuplicates is INSERT ... ON CONFLICT
  // DO UPDATE, which RLS rejects on these append-only tables (no UPDATE policy) as soon as
  // the row exists — the 42501 that broke every refresh of /today.
  it("never issues an ON CONFLICT DO UPDATE write against these append-only tables", async () => {
    const { supabase, calls } = fakeSupabase({ plan: null, revisions: 0 });
    await ensurePlan(supabase, "user-1", "day-1");
    expect(writes(calls).length).toBeGreaterThan(0);
    for (const call of writes(calls)) expect(call.opts?.ignoreDuplicates).toBe(true);
  });

  it("surfaces a database error as ExternalServiceError without leaking its detail", async () => {
    const { supabase } = fakeSupabase({ plan: null, revisions: 0 }, "plans");
    const error = await ensurePlan(supabase, "user-1", "day-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as ExternalServiceError).message).not.toContain("denied");
  });
});
