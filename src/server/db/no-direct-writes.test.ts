import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard for migration 4.1b: `days`, `plans` and `plan_revisions` are written ONLY by the
 * SECURITY DEFINER functions (ensure_day, reschedule_task, apply_replan). `authenticated` holds
 * SELECT on them and nothing else, so any direct write from application code would fail at
 * runtime — this test fails at build time instead. It scans every non-test source file for a
 * `.from("<locked table>")` query chain that contains a write verb.
 */
const LOCKED = [
  "days",
  "plans",
  "plan_revisions",
  "tasks",
  "task_history",
  "ai_proposals",
  "push_subscriptions",
  "scheduled_notifications",
  "eod_reports",
];
const WRITE = /\.(insert|upsert|update|delete)\s*\(/;
const SRC = join(process.cwd(), "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Every `.from("table")` occurrence with the rest of its call chain (up to the statement end). */
function chains(source: string) {
  const found: { table: string; chain: string }[] = [];
  const re = /\.from\(\s*["'`](\w+)["'`]\s*\)/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const rest = source.slice(m.index + m[0].length);
    const end = rest.search(/;\s*(\n|$)/);
    found.push({ table: m[1]!, chain: end === -1 ? rest : rest.slice(0, end) });
  }
  return found;
}

describe("no direct writes to the locked tables from application code", () => {
  const all = files(SRC).map((file) => ({
    file: relative(process.cwd(), file),
    source: readFileSync(file, "utf8"),
  }));

  it("scans a meaningful set of files", () => {
    expect(all.length).toBeGreaterThan(50);
    expect(all.some((f) => f.file.endsWith("repositories/days.ts"))).toBe(true);
  });

  it.each(LOCKED)("nothing writes `%s` through the query builder", (table) => {
    const offenders = all.flatMap(({ file, source }) =>
      chains(source)
        .filter((c) => c.table === table && WRITE.test(c.chain))
        .map(() => file),
    );
    expect(offenders).toEqual([]);
  });

  it("the scanner itself does catch a write (self-test)", () => {
    const bad = chains(`await supabase.from("days").upsert({ a: 1 }, { onConflict: "x" });`);
    expect(bad).toHaveLength(1);
    expect(WRITE.test(bad[0]!.chain)).toBe(true);
    const ok = chains(`const { data } = await supabase.from("days").select("id").eq("id", 1);`);
    expect(WRITE.test(ok[0]!.chain)).toBe(false);
  });

  it("every remaining direct writer in the app is on an unlocked table (profiles, briefings) or an RPC", () => {
    const writers = all.flatMap(({ file, source }) =>
      chains(source)
        .filter((c) => WRITE.test(c.chain))
        .map((c) => `${file}:${c.table}`),
    );
    expect(writers.sort()).toEqual([
      "src/server/db/repositories/briefings.ts:briefings",
      "src/server/db/repositories/profiles.ts:profiles",
    ]);
  });

  it("the locked tables are only ever read directly: selects and RPCs", () => {
    const readers = all.flatMap(({ file, source }) =>
      chains(source)
        .filter((c) => ["days", "plans", "plan_revisions", "ai_proposals"].includes(c.table))
        .map((c) => `${file}:${c.table}`),
    );
    expect(readers.sort()).toEqual(
      [
        "src/server/db/repositories/days.ts:days",
        "src/server/db/repositories/days.ts:days",
        "src/server/db/repositories/plans.ts:plan_revisions", // read-only: getLatestRevisionNumber
        "src/server/db/repositories/plans.ts:plans",
        "src/server/db/repositories/plan-revisions.ts:plan_revisions", // read-only: listRevisionNumbers (Phase 7)
        "src/server/db/repositories/ai-proposals.ts:ai_proposals", // findPendingProposal
        "src/server/db/repositories/ai-proposals.ts:ai_proposals", // getAiProposalById
      ].sort(),
    );
  });
});
