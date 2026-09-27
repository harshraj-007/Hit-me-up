-- ─────────────────────────────────────────────────────────────────────────
-- Phase 4.1b: close the direct write path to days, plans and plan_revisions.
--
-- Apply ONLY after the Phase 4.1 application code is running (it creates days, plans and
-- revisions solely through ensure_day() and never writes these tables itself) and 4.1a /
-- 4.1a-2 have been verified live. The application code that shipped before 4.1 upserted `days`
-- and `plans` directly and would break once this is applied.
--
-- Why: a planning day's bounds are derived from `days.local_date` and `days.timezone`, and the
-- RPCs that enforce "a task starts inside its planning day" trust those columns. While a user
-- could UPDATE their own day's timezone (or INSERT arbitrary days), that boundary was only as
-- strong as the app's good behavior. After this migration the ONLY writers of days, plans and
-- plan_revisions are the SECURITY DEFINER functions — ensure_day() (day, plan, revision 1),
-- reschedule_task() and apply_replan() (later revisions) — which run as the table owner.
--
-- Nothing else changes: `profiles` and `briefings` are untouched (the briefings foreign key to
-- `days` is checked with the owner's privileges, so briefing inserts keep working); `tasks` and
-- `task_history` are already SELECT-only; the SELECT policies stay, so RLS still scopes reads to
-- the owner. `revoke all` also removes the default REFERENCES/TRIGGER/TRUNCATE/MAINTAIN grants
-- and every `anon` privilege; `service_role` is untouched. No data is read or changed.
-- ─────────────────────────────────────────────────────────────────────────

drop policy "days: insert own" on public.days;
drop policy "days: update own" on public.days;

drop policy "plans: insert own" on public.plans;
drop policy "plan_revisions: insert own" on public.plan_revisions;

revoke all on public.days, public.plans, public.plan_revisions
  from anon, authenticated;

grant select on public.days, public.plans, public.plan_revisions
  to authenticated;
