-- ─────────────────────────────────────────────────────────────────────────
-- Phase 6.1: Web Push subscription infrastructure (user-facing lifecycle only).
--
-- This migration adds ONLY subscription persistence — register/revoke a browser's
-- PushSubscription. It intentionally does NOT add scheduled_notifications,
-- notification_deliveries, any reconciliation/claim function, or anything reachable by
-- service_role: those belong to the automation/delivery phase. Nothing here sends a push
-- notification, and nothing here is written or read by any AI/scheduling path.
--
-- ── 1. push_subscriptions ────────────────────────────────────────────────
-- One row per browser/device subscription. `endpoint` is the subscription's own identity —
-- it is unique per browser/device/origin combination, issued by the push service, and is what
-- de-duplicates re-registration. A user may hold many rows (multi-device is supported by
-- design: no unique(user_id)). Deliberately minimal — no device name, browser/user-agent,
-- IP address, notification content, VAPID material, or delivery state belongs on this table;
-- see PROJECT_ARCHITECTURE.md's Phase 6 recon for why each of those was left out.
--
-- Revocation sets `revoked_at`, it never deletes the row: this preserves the subscription's
-- identity (so a repeated revoke is a harmless no-op, and the endpoint's history is not lost),
-- the same posture `ai_proposals` uses for `status = 'discarded'` rather than a physical delete.
create table public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  -- The push service's own subscription URL. Long (well under 2KB in every real
  -- implementation) but bounded defensively; see register_push_subscription()'s own check.
  endpoint     text not null,
  -- The two keys PushManager.subscribe() returns (base64url-encoded); needed to encrypt a
  -- push payload for this specific subscription. Treated as sensitive throughout — never
  -- logged (see logging/redact.ts) and never sent anywhere except the future delivery step.
  p256dh       text not null,
  auth_key     text not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz,
  constraint push_subscriptions_endpoint_unique unique (endpoint),
  constraint push_subscriptions_endpoint_not_blank check (btrim(endpoint) <> ''),
  constraint push_subscriptions_endpoint_length check (char_length(endpoint) <= 2048),
  constraint push_subscriptions_p256dh_not_blank check (btrim(p256dh) <> ''),
  constraint push_subscriptions_auth_key_not_blank check (btrim(auth_key) <> '')
);

create index push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

create policy "push_subscriptions: select own"
  on public.push_subscriptions for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- No insert/update/delete policy: every write goes through a SECURITY DEFINER RPC below, the
-- same posture as tasks/task_history/days/plans/plan_revisions/ai_proposals since migration
-- 4.1b. Neither RPC below is granted to service_role, and that absence is deliberate too:
-- Phase 6.1 has no automation path yet, so nothing in this migration is reachable by anything
-- other than the subscription's own owner, authenticated normally.
revoke all on public.push_subscriptions from anon, authenticated;
grant select on public.push_subscriptions to authenticated;

-- ── 2. register_push_subscription ───────────────────────────────────────
-- The only way a subscription row is created or refreshed. Ownership always comes from
-- auth.uid() — p_endpoint/p_p256dh/p_auth_key are the only inputs, and none of them can name a
-- user.
--
-- ENDPOINT OWNERSHIP (read this before touching the upsert): `endpoint` is unique per browser
-- subscription, but it is a plain string parameter to this function — nothing here
-- independently proves the caller's browser actually holds a live PushSubscription for the
-- endpoint it supplies (that proof exists only at the browser/push-service level, which this
-- RPC cannot see). A naive `on conflict (endpoint) do update set user_id = excluded.user_id`
-- would therefore let an authenticated user B silently take over an endpoint row that still
-- actively belongs to a DIFFERENT user A, by simply calling this RPC with A's endpoint string
-- (e.g. one that leaked via a log, a compromised client, or a shared/leaked device). That
-- would not expose any of A's data to B, but it WOULD hijack A's physical device: once
-- delivery exists, A's device would start receiving B's reminders, and A's own reminders would
-- silently stop arriving there.
--
-- So the upsert only refreshes a conflicting row when it is SAFE to do so: the row already
-- belongs to the SAME caller (ordinary idempotent re-registration — ordinary browser refresh,
-- re-opening the app, or a genuinely revoked-then-restored subscription), OR the row has
-- already been explicitly revoked (`revoked_at is not null`) — a real signal from its previous
-- owner (or an earlier, safe automated revoke) that it no longer claims that endpoint, at which
-- point a NEW owner adopting a since-abandoned endpoint (e.g. the legitimate "different account
-- signs in on a shared device, after signing out and revoking" flow) is not a security concern.
-- An endpoint that is still actively (unrevoked) owned by someone else is left completely
-- untouched, and the caller gets a clear, safe error instead of a silent takeover.
--
-- This is enforced with a WHERE clause on `do update`: if it evaluates false for the
-- conflicting row, Postgres leaves that row untouched and RETURNING yields nothing for it —
-- which `if not found` below detects.
--
-- Errors: 42501 not authenticated · 22023 malformed input ·
--         P0002 endpoint already actively registered to a different user
create function public.register_push_subscription(
  p_endpoint text,
  p_p256dh   text,
  p_auth_key text
)
returns public.push_subscriptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.push_subscriptions;
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_endpoint is null or btrim(p_endpoint) = '' or char_length(p_endpoint) > 2048 then
    raise exception 'endpoint is required and must be at most 2048 characters' using errcode = '22023';
  end if;
  if p_p256dh is null or btrim(p_p256dh) = '' then
    raise exception 'p256dh is required' using errcode = '22023';
  end if;
  if p_auth_key is null or btrim(p_auth_key) = '' then
    raise exception 'auth_key is required' using errcode = '22023';
  end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth_key)
  values ((select auth.uid()), p_endpoint, p_p256dh, p_auth_key)
  on conflict (endpoint) do update
     set user_id      = excluded.user_id,
         p256dh       = excluded.p256dh,
         auth_key     = excluded.auth_key,
         last_seen_at = now(),
         revoked_at   = null
   where public.push_subscriptions.user_id = excluded.user_id
      or public.push_subscriptions.revoked_at is not null
  returning * into v_row;

  if not found then
    raise exception 'endpoint % is already registered to a different active subscription', p_endpoint
      using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

revoke execute on function public.register_push_subscription(text, text, text) from public, anon;
grant  execute on function public.register_push_subscription(text, text, text) to authenticated;

-- ── 3. revoke_push_subscription ─────────────────────────────────────────
-- The user explicitly turning off notifications on a device ("Turn off on this device").
-- Sets revoked_at rather than deleting, and only ever affects a row the caller owns; a
-- missing, foreign, or already-revoked endpoint is the same safe no-op in every case — none
-- of them should look different to the caller, and none reveals whether the endpoint exists at
-- all or who owns it. Never a generic UPDATE: this is the one narrow, explicit mutation
-- boundary revocation gets.
create function public.revoke_push_subscription(
  p_endpoint text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  update public.push_subscriptions
     set revoked_at = now()
   where endpoint = p_endpoint
     and user_id = (select auth.uid())
     and revoked_at is null;
end;
$$;

revoke execute on function public.revoke_push_subscription(text) from public, anon;
grant  execute on function public.revoke_push_subscription(text) to authenticated;
