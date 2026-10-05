-- ─────────────────────────────────────────────────────────────────────────
-- Phase 6 live-verification hardening: service_role EXECUTE on user-session RPCs.
--
-- Found by re-running the Phase 6.1 isolation suite (its CASE 18) against a scratch Postgres
-- that mirrors a Supabase project's default privileges: Supabase grants EXECUTE on every new
-- `public` function to `service_role` by default — the same bootstrap behavior Phase 6.3
-- found for TABLES (`alter default privileges ... to anon, authenticated, service_role`), and
-- closed for the three tables it touched. The function half of that default was never closed,
-- so `service_role` could EXECUTE every user-session RPC.
--
-- NOT exploitable today, and verified so: every one of these functions raises 42501
-- ("not authenticated") for a JWT with no `sub` — which is what a service_role token is — via
-- its own internal `auth.uid() is null` check (checked for all 11 in scratch Postgres). This
-- migration is least-privilege hygiene, not a vulnerability fix: the one role that holds the
-- service-role key (the CRON_SECRET-gated cron path) has no reason to be able to even attempt
-- these, and Phase 6.1's own documentation and test already claim it can't.
--
-- The same run found the TABLE half still only partly closed: Phase 6.3 revoked service_role's
-- default write privileges on the three tables it touched (tasks, push_subscriptions,
-- scheduled_notifications), but every OTHER public table (days, plans, plan_revisions, briefings,
-- profiles, task_history, ai_proposals) still carried the default full CRUD. The cron path reads
-- exactly three tables and writes none directly (all its writes are the three system RPCs, which
-- run as the function owner), so section 2 below applies Phase 6.3's posture to every public
-- table at once: revoke everything, then re-grant SELECT on the three tables delivery reads.
--
-- Scope: the user-session RPCs (section 1) and service_role's table privileges (section 2). The three system RPCs the cron path legitimately uses
-- (reconcile_and_claim_notifications, mark_notification_sent, revoke_push_subscription_by_id)
-- keep their service_role-only grants untouched. Idempotent: REVOKE of an absent privilege is
-- a no-op. No table, policy, or function body changes.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. user-session RPCs ────────────────────────────────────────────────
revoke execute on function public.ensure_day(date) from service_role;
revoke execute on function public.create_task_with_history(
  uuid, text, text, text, text, timestamptz, timestamptz, timestamptz, text
) from service_role;
revoke execute on function public.change_task_status(uuid, text) from service_role;
revoke execute on function public.reschedule_task(uuid, timestamptz, timestamptz) from service_role;
revoke execute on function public.apply_replan(uuid, jsonb) from service_role;
revoke execute on function public.confirm_ai_proposal(uuid, integer, jsonb) from service_role;
revoke execute on function public.confirm_ai_proposal_by_id(uuid) from service_role;
revoke execute on function public.create_ai_proposal(
  uuid, integer, text, text, text, jsonb, jsonb, jsonb, jsonb, text
) from service_role;
revoke execute on function public.discard_ai_proposal(uuid) from service_role;
revoke execute on function public.register_push_subscription(text, text, text) from service_role;
revoke execute on function public.revoke_push_subscription(text) from service_role;

-- ── 2. table privileges ─────────────────────────────────────────────────
-- Identical end state to Phase 6.3 for its three tables; newly applied to all the others. A new
-- table added by a later migration still arrives with Supabase's default grants and must revoke
-- them explicitly in its own migration (as eod_reports does) — this statement only covers
-- tables that exist when it runs.
revoke all on all tables in schema public from service_role;
grant select on public.tasks to service_role;
grant select on public.push_subscriptions to service_role;
grant select on public.scheduled_notifications to service_role;
