import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAutoMovable } from "@/domain/scheduling";
import {
  at,
  DAY_ID,
  makeTask,
  NOW,
  OTHER_DAY_ID,
} from "../../../tests/support/ai-planning-fixtures";
import { isAiMovable } from "./movability";

const base = { start: at(17), end: at(18) };
const ai = (o: Parameters<typeof makeTask>[0]) => isAiMovable(makeTask(o), NOW, DAY_ID);
const auto = (o: Parameters<typeof makeTask>[0]) => isAutoMovable(makeTask(o), NOW, DAY_ID);

describe("isAiMovable (proposal-time eligibility)", () => {
  it("allows user-created and planner-created unresolved tasks", () => {
    expect(ai({ ...base, source: "user" })).toBe(true);
    expect(ai({ ...base, source: "planner" })).toBe(true);
  });
  it("allows an unscheduled task and a late task", () => {
    expect(ai({ ...base, unscheduled: true })).toBe(true);
    expect(ai({ start: at(6), end: at(7) })).toBe(true);
  });
  it.each([
    ["completed", { status: "completed" as const }],
    ["skipped", { status: "skipped" as const }],
    ["locked", { scheduleLocked: true }],
    ["fixed", { kind: "fixed" as const }],
    ["in progress", { start: at(8, 30), end: at(9, 30) }],
    ["another day's (spillover)", { dayId: OTHER_DAY_ID }],
  ])("refuses a %s task", (_l, over) => {
    expect(ai({ ...base, ...over })).toBe(false);
  });
});

describe("the deterministic planner's rule is untouched", () => {
  it("isAutoMovable is still planner-only: a user-created task is NOT auto-movable", () => {
    expect(auto({ ...base, source: "user" })).toBe(false);
    expect(auto({ ...base, source: "planner" })).toBe(true);
  });
  it("the two rules differ exactly on task source", () => {
    expect(ai({ ...base, source: "user" })).not.toBe(auto({ ...base, source: "user" }));
  });
  it("apply_replan still only touches planner-sourced tasks (migration unchanged)", () => {
    const dir = path.resolve(import.meta.dirname, "../../../supabase/migrations");
    const sql = fs.readFileSync(
      path.join(dir, "20260924120000_phase4_derived_late_and_replanning.sql"),
      "utf8",
    );
    const body = sql.slice(sql.indexOf("function public.apply_replan"));
    expect(body).toMatch(/and source = 'planner'/);
    // 6 from Phase 4/4.1/4.1b, Phase 5.3's confirm_ai_proposal, Phase 5.5's persisted-proposal
    // RPCs, Phase 6.1's push_subscriptions RPCs, Phase 6.2's scheduled_notifications
    // reconcile/claim RPC, and Phase 6.3's mark_notification_sent/revoke_push_subscription_by_id
    // — all new, separate functions; apply_replan() itself is untouched by any of them — plus
    // the two Phase 6 live-verification follow-ups (service_role grant hardening; the overlapping-
    // cron creation race), which only revoke privileges / re-declare the reconcile function.
    expect(fs.readdirSync(dir)).toHaveLength(13);
  });
});
