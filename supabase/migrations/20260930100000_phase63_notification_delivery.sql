-- ─────────────────────────────────────────────────────────────────────────
-- Phase 6.3: Web Push delivery — the two narrow database capabilities delivery needs that
-- Phase 6.1/6.2 didn't already provide, plus the read grants delivery needs to do its job.
-- No new table. No Web Push sending happens in SQL — this file only prepares the ground for
-- the Node-side delivery service (`src/server/services/notification-delivery.ts`) to finalize
-- a claimed notification and revoke a dead subscription, both narrowly and atomically.
--
-- ── 1. Read grants service_role needs for delivery ──────────────────────
-- IMPORTANT, found by this phase's own real-Postgres verification (not by inspection): a
-- Supabase project's bootstrap grants `service_role` full INSERT/UPDATE/DELETE/SELECT on every
-- table by DEFAULT (via `alter default privileges ... to service_role`, applied to new tables
-- automatically) — the same default `anon`/`authenticated` get, which every migration since
-- 4.1b has been careful to `revoke all` from. Phase 6.1/6.2 never did the equivalent for
-- `service_role` on `push_subscriptions`/`scheduled_notifications`, because the assumption at
-- the time was "service_role starts with nothing, we're only ever granting it what it needs" —
-- true for `anon`/`authenticated`, false for `service_role`. That left `service_role` able to
-- write either table directly, bypassing the RPC boundary entirely, purely by default,
-- undetected until this migration's own scratch-Postgres check caught it.
--
-- Fixed here, narrowly, for exactly the three tables Phase 6.3's delivery path touches:
-- `tasks` and `push_subscriptions` (new reads this phase needs) and `scheduled_notifications`
-- (Phase 6.2's own table, closed here rather than by editing that migration — see this file's
-- own header for why an addative fix here, not a change to 6.1/6.2, is the right shape). Every
-- one of them keeps working exactly as before: every actual write already goes through a
-- SECURITY DEFINER RPC, none of which needed more than SELECT on the underlying tables to do
-- their job (they mutate via `update ... returning`/`insert` INSIDE the function, which runs as
-- the function OWNER — `postgres`, a superuser — not as `service_role`, so this revoke cannot
-- break any existing RPC). Task NOTES are still never selected by any Phase 6.3 code regardless
-- of this grant existing (see the payload builder) — this only closes an unused-but-open door.
revoke all on public.tasks, public.push_subscriptions, public.scheduled_notifications from service_role;
grant select on public.tasks to service_role;
grant select on public.push_subscriptions to service_role;
grant select on public.scheduled_notifications to service_role;

-- ── 2. mark_notification_sent ────────────────────────────────────────────
-- The ONE new terminal transition delivery needs that Phase 6.2 itself never performs (Phase
-- 6.2 defined the 'sent' status in its CHECK constraint but never sets it — sending is exactly
-- what Phase 6.2 explicitly deferred). Only a currently-`claimed` row can be marked sent; a
-- foreign, missing, or already-resolved id is a silent no-op — the same posture
-- `discard_ai_proposal`/`revoke_push_subscription` use, and for the same reason: the caller
-- (the delivery service, right after a successful send) should never need to distinguish those
-- cases, and none of them should look different.
--
-- Deliberately does NOT accept a "reason"/"result" payload beyond "sent": that is the only
-- outcome Phase 6.3 ever needs to persist. Every other outcome (transient failure, no active
-- subscriptions, all subscriptions permanently invalid) is handled by leaving the row
-- `claimed` and letting Phase 6.2's OWN, already-hardened lease-recovery step decide its next
-- state on a later cron tick — see PROJECT_ARCHITECTURE.md's Phase 6.3 section for why this is
-- the chosen aggregate policy, and why it needs no second attempt counter.
create function public.mark_notification_sent(
  p_notification_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  -- claimed_at is cleared here, not just resolved_at set: the table's own CHECK constraint
  -- requires claimed_at to be null whenever status isn't 'claimed' — a real transition off of
  -- 'claimed', caught by real Postgres verification the same way Phase 6.2's own
  -- lease-expiry step's identical mistake was (see that migration's comment).
  update public.scheduled_notifications
     set status = 'sent', claimed_at = null, resolved_at = now(), updated_at = now()
   where id = p_notification_id
     and status = 'claimed';
end;
$$;

revoke execute on function public.mark_notification_sent(uuid) from public, anon, authenticated;
grant  execute on function public.mark_notification_sent(uuid) to service_role;

-- ── 3. revoke_push_subscription_by_id ────────────────────────────────────
-- Phase 6.1's `revoke_push_subscription(p_endpoint)` is `auth.uid()`-scoped — correct for the
-- user-facing "turn off on this device" flow, but unusable from the cron/delivery path, which
-- has no user session at all. This is the system-facing sibling: same effect (sets
-- `revoked_at`, never deletes), same silent-no-op-on-anything-not-currently-active posture, but
-- authorized by `auth.role() = 'service_role'` instead of ownership, and addressed by the
-- subscription's own id (which delivery already has from its own read) rather than an
-- endpoint. It does not, and must not, accept a user id: which row it can touch is entirely
-- determined by `p_subscription_id` referring to an existing, still-active row — there is no
-- ownership check to bypass here because there is no ownership claim being made at all; the
-- caller is the trusted system path, not a user claiming to own something.
create function public.revoke_push_subscription_by_id(
  p_subscription_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  update public.push_subscriptions
     set revoked_at = now()
   where id = p_subscription_id
     and revoked_at is null;
end;
$$;

revoke execute on function public.revoke_push_subscription_by_id(uuid) from public, anon, authenticated;
grant  execute on function public.revoke_push_subscription_by_id(uuid) to service_role;
