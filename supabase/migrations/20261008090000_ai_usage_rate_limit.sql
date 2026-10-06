-- ─────────────────────────────────────────────────────────────────────────
-- Per-user AI usage limit (shared budget across every model-calling feature).
--
-- Every model call the app makes costs real money and any signed-in user can trigger one by
-- invoking a Server Action, so the budget is enforced in the database (the only state serverless
-- instances share) BEFORE the provider is called:
--
--   ai_usage_events   append-only: one row per RESERVED model call — (user, feature, when), and
--                     nothing else. No prompt, no response, no task text, no note, no email.
--   ai_usage_limits   one locked row holding the two ceilings (per rolling hour / per rolling day).
--   reserve_ai_call() the only writer. Atomic check-and-reserve under a per-user advisory lock.
--
-- ONE SHARED BUDGET: planning ("plan"), plan-from-briefing ("briefing_plan") and the end-of-day
-- review ("eod_review") all draw on the same two ceilings. Resuming or confirming a stored
-- proposal makes no model call and never reserves anything.
--
-- WHERE THE LIMITS LIVE (change them here, no deploy needed):
--     update public.ai_usage_limits set hourly_limit = <n>, daily_limit = <m>;
-- They are held in SQL on purpose and NOT passed in by the caller: if the caller supplied them, any
-- signed-in user could call this RPC directly with huge limits and insert unbounded rows. With the
-- limits server-side, a user at their ceiling gets a refusal and nothing is written, so one user
-- can never create more than `daily_limit` rows a day.
--
-- *** The seeded values below are DEVELOPMENT / TESTING placeholders (20 per hour, 100 per day). ***
-- *** They have NOT been chosen for production; set them deliberately before going live.        ***
--
-- Semantics:
--  * A reservation is made before the provider call and is NOT refunded if the call then fails —
--    a failed call still reached (and may have been billed by) the provider.
--  * Windows are rolling: the last hour and the last 24 hours, measured at the moment of the call.
--  * A refusal returns { allowed: false, window, retry_after_seconds } — the exact time until
--    enough of the oldest counted reservations age out for a call to be allowed — and writes
--    nothing. When both ceilings are hit it reports the longer wait.
--  * Concurrency: a transaction-scoped advisory lock keyed on the user serializes the
--    count-then-insert, so parallel requests cannot all see "one slot left" and all take it.
--    Different users never contend. The lock is released at commit/rollback — nothing to clean up.
--  * Errors: 42501 not authenticated · 22023 unknown feature.
--
-- Security: SECURITY DEFINER, `set search_path = ''`, identity only from auth.uid() (there is no
-- user-id parameter to spoof), no dynamic SQL, EXECUTE for `authenticated` only (revoked from
-- PUBLIC, anon and — explicitly, because Supabase grants it by default — service_role: the cron
-- path never calls a model). Clients may SELECT their own events; nobody may write the table
-- directly, and the limits table is not readable or writable by any API role.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. the limits (one locked row) ───────────────────────────────────────
create table public.ai_usage_limits (
  singleton    boolean primary key default true,
  hourly_limit integer not null,
  daily_limit  integer not null,
  constraint ai_usage_limits_singleton check (singleton),
  constraint ai_usage_limits_hourly_positive check (hourly_limit > 0),
  constraint ai_usage_limits_daily_positive check (daily_limit > 0)
);

-- DEVELOPMENT / TESTING VALUES — see the header. Not production thresholds.
insert into public.ai_usage_limits (hourly_limit, daily_limit) values (20, 100);

alter table public.ai_usage_limits enable row level security;  -- no policy: no API role can read it
revoke all on public.ai_usage_limits from public, anon, authenticated, service_role;

-- ── 2. the usage events (append-only) ────────────────────────────────────
create table public.ai_usage_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  feature    text not null,
  created_at timestamptz not null default now(),
  constraint ai_usage_events_feature_check check (feature in ('plan', 'briefing_plan', 'eod_review'))
);

create index ai_usage_events_user_created_idx on public.ai_usage_events (user_id, created_at desc);

alter table public.ai_usage_events enable row level security;

create policy "ai_usage_events: select own"
  on public.ai_usage_events for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- No insert/update/delete policy and no such privilege: every write is reserve_ai_call() below.
revoke all on public.ai_usage_events from public, anon, authenticated, service_role;
grant select on public.ai_usage_events to authenticated;
revoke all on sequence public.ai_usage_events_id_seq from public, anon, authenticated, service_role;

-- ── 3. reserve_ai_call ───────────────────────────────────────────────────
create function public.reserve_ai_call(p_feature text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_hourly     integer;
  v_daily      integer;
  v_now        timestamptz;
  v_hour_count integer;
  v_day_count  integer;
  v_hour_wait  integer := 0;
  v_day_wait   integer := 0;
  v_oldest     timestamptz;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_feature is null or p_feature not in ('plan', 'briefing_plan', 'eod_review') then
    raise exception 'unknown AI feature' using errcode = '22023';
  end if;

  select hourly_limit, daily_limit into v_hourly, v_daily from public.ai_usage_limits;

  -- Serialize this user's check-and-reserve. Taken BEFORE counting so every concurrent request
  -- counts what the previous one just wrote.
  perform pg_advisory_xact_lock(hashtextextended('ai_usage:' || v_uid::text, 0));

  -- Read the clock only after the lock is held, so reservations are ordered by their real time.
  v_now := clock_timestamp();

  select count(*) into v_hour_count
    from public.ai_usage_events
   where user_id = v_uid and created_at > v_now - interval '1 hour';
  select count(*) into v_day_count
    from public.ai_usage_events
   where user_id = v_uid and created_at > v_now - interval '24 hours';

  -- A refused window waits until the (count - limit + 1)-th oldest counted reservation ages out.
  if v_hour_count >= v_hourly then
    select created_at into v_oldest
      from public.ai_usage_events
     where user_id = v_uid and created_at > v_now - interval '1 hour'
     order by created_at asc
     offset (v_hour_count - v_hourly) limit 1;
    v_hour_wait := greatest(1, ceil(extract(epoch from (v_oldest + interval '1 hour' - v_now)))::integer);
  end if;
  if v_day_count >= v_daily then
    select created_at into v_oldest
      from public.ai_usage_events
     where user_id = v_uid and created_at > v_now - interval '24 hours'
     order by created_at asc
     offset (v_day_count - v_daily) limit 1;
    v_day_wait := greatest(1, ceil(extract(epoch from (v_oldest + interval '24 hours' - v_now)))::integer);
  end if;

  if v_hour_wait > 0 or v_day_wait > 0 then
    return jsonb_build_object(
      'allowed', false,
      'window', case when v_day_wait > v_hour_wait then 'day' else 'hour' end,
      'retry_after_seconds', greatest(v_hour_wait, v_day_wait)
    );
  end if;

  insert into public.ai_usage_events (user_id, feature, created_at)
  values (v_uid, p_feature, v_now);
  return jsonb_build_object('allowed', true);
end;
$$;

revoke execute on function public.reserve_ai_call(text) from public, anon, service_role;
grant  execute on function public.reserve_ai_call(text) to authenticated;
