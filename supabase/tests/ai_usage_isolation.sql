-- ─────────────────────────────────────────────────────────────────────────
-- AI usage limit integrity / isolation check (ai_usage_events + ai_usage_limits + reserve_ai_call).
--
-- Same technique as the other files in this directory: throwaway auth.users rows, impersonated via
-- the `request.jwt.claims` GUC, everything inside ONE transaction, rolled back at the end. Run it
-- against a real Postgres whose roles mirror Supabase's, with every migration applied:
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ai_usage_isolation.sql
--
-- Covers: authentication (no identity / anon / service_role), unknown features, the hourly and daily
-- ceilings, the rolling windows (events fall out exactly when they should), the exact retry-after
-- the RPC reports, that a refusal writes nothing, per-user independence, ONE budget shared by every
-- feature, RLS and ownership, no direct writes, the table's shape (no payload columns), and the
-- catalog facts (SECURITY DEFINER, empty search_path, grants). Two real connections racing are
-- exercised by supabase/tests/concurrent_ai_usage.sh.
--
-- The ceilings are changed inside the transaction (as the table owner, which is what this script
-- runs as before it switches role) and rolled back with everything else.
-- ─────────────────────────────────────────────────────────────────────────

begin;

insert into auth.users (id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('00000000-0000-0000-0000-0000000009a1', 'authenticated', 'authenticated', 'usage-a@example.test', '', now(), now()),
  ('00000000-0000-0000-0000-0000000009b2', 'authenticated', 'authenticated', 'usage-b@example.test', '', now(), now());

create schema usagetest;
grant usage on schema usagetest to public;

create function usagetest.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

create function usagetest.expect(p_label text, p_sql text, p_state text) returns void
language plpgsql as $$
declare got text := usagetest.try(p_sql);
begin
  if got is distinct from p_state then
    raise exception '% FAILED: expected %, got %', p_label, p_state, got;
  end if;
  raise notice '% — OK', p_label;
end;
$$;

-- One reservation as the current role; returns the RPC's jsonb.
create function usagetest.reserve(p_feature text default 'plan') returns jsonb language sql as $$
  select public.reserve_ai_call(p_feature)
$$;
create function usagetest.allowed(p_feature text default 'plan') returns boolean language sql as $$
  select (public.reserve_ai_call(p_feature) ->> 'allowed')::boolean
$$;
grant execute on all functions in schema usagetest to public;

-- ── case 1: who may call it (before any role switch the script is the table owner) ───────────────
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select usagetest.expect('CASE 1a: anon cannot reserve (42501)', $$select public.reserve_ai_call('plan')$$, '42501');

set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
select usagetest.expect('CASE 1b: service_role cannot reserve (42501)', $$select public.reserve_ai_call('plan')$$, '42501');

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select usagetest.expect('CASE 1c: authenticated with NO sub cannot reserve (42501)', $$select public.reserve_ai_call('plan')$$, '42501');

-- ── case 2: unknown features ──────────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000009a1', 'role', 'authenticated')::text, true);
select usagetest.expect('CASE 2a: unknown feature (22023)', $$select public.reserve_ai_call('bogus')$$, '22023');
select usagetest.expect('CASE 2b: empty feature (22023)', $$select public.reserve_ai_call('')$$, '22023');
select usagetest.expect('CASE 2c: NULL feature (22023)', $$select public.reserve_ai_call(null)$$, '22023');
select usagetest.expect('CASE 2d: wrong case (22023)', $$select public.reserve_ai_call('PLAN')$$, '22023');
select usagetest.expect('CASE 2e: SQL in the feature is just an unknown feature (22023)',
  $$select public.reserve_ai_call('plan''; drop table public.tasks; --')$$, '22023');
do $$ begin
  if (select count(*) from public.ai_usage_events) <> 0 then
    raise exception 'CASE 2 FAILED: a malformed reservation wrote a row';
  end if;
end $$;

-- ── the ceilings for the rest of the script (reset role to be the owner for the setup) ──────────
reset role;
update public.ai_usage_limits set hourly_limit = 3, daily_limit = 5;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000009a1', 'role', 'authenticated')::text, true);

-- ── case 3: hourly ceiling ────────────────────────────────────────────────────────────────────────
do $$
declare r jsonb; n int;
begin
  for i in 1..3 loop
    r := usagetest.reserve('plan');
    if r is distinct from '{"allowed": true}'::jsonb then
      raise exception 'CASE 3 FAILED: reservation % should be allowed, got %', i, r;
    end if;
  end loop;
  select count(*) into n from public.ai_usage_events;
  if n <> 3 then raise exception 'CASE 3 FAILED: expected 3 events, got %', n; end if;
  raise notice 'CASE 3a: under the hourly ceiling every reservation is allowed and recorded — OK';

  r := usagetest.reserve('plan');
  if (r ->> 'allowed')::boolean or r ->> 'window' <> 'hour'
     or (r ->> 'retry_after_seconds')::int not between 1 and 3600 then
    raise exception 'CASE 3 FAILED: the 4th call should be refused for the hour window, got %', r;
  end if;
  select count(*) into n from public.ai_usage_events;
  if n <> 3 then raise exception 'CASE 3 FAILED: a refusal wrote a row (now %)', n; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(r) k) <> array['allowed', 'retry_after_seconds', 'window'] then
    raise exception 'CASE 3 FAILED: a refusal exposes unexpected keys: %', r;
  end if;
  raise notice 'CASE 3b: the hourly ceiling refuses, with window + retry-after only, and writes nothing — OK';
end $$;

-- ── case 4: the rolling window — events fall out exactly when they should ───────────────────────
reset role;
-- A's three events are "now"; make them ancient/near: one 59 minutes old, one 61 minutes old, one fresh.
with ordered as (select id, row_number() over (order by id) rn from public.ai_usage_events
                  where user_id = '00000000-0000-0000-0000-0000000009a1')
update public.ai_usage_events e
   set created_at = case o.rn when 1 then clock_timestamp() - interval '61 minutes'
                              when 2 then clock_timestamp() - interval '59 minutes'
                              else clock_timestamp() end
  from ordered o where o.id = e.id;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000009a1', 'role', 'authenticated')::text, true);
do $$
declare r jsonb;
begin
  -- 61-minute-old event is outside the hour: 2 count (59 min, fresh) → one slot free.
  if not usagetest.allowed('plan') then raise exception 'CASE 4 FAILED: an event 61 minutes old still counted'; end if;
  -- Now 3 count (59 min, fresh, new): refused, and it waits for the 59-minute-old one: ~60 seconds.
  r := usagetest.reserve('plan');
  if (r ->> 'allowed')::boolean or (r ->> 'retry_after_seconds')::int not between 50 and 62 then
    raise exception 'CASE 4 FAILED: retry-after should be ~60s (the 59-minute-old event ages out), got %', r;
  end if;
  raise notice 'CASE 4a: events outside the rolling hour do not count; retry-after is exactly when the oldest counted one ages out — OK';
end $$;

reset role;
-- Make the 59-minute-old event 1 second from expiring: the call after it must be allowed in ~1s.
update public.ai_usage_events set created_at = clock_timestamp() - interval '3599 seconds'
 where id = (select min(id) from public.ai_usage_events where user_id = '00000000-0000-0000-0000-0000000009a1'
              and created_at > clock_timestamp() - interval '1 hour');
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000009a1', 'role', 'authenticated')::text, true);
do $$
declare r jsonb;
begin
  r := usagetest.reserve('plan');
  if (r ->> 'allowed')::boolean or (r ->> 'retry_after_seconds')::int <> 1 then
    raise exception 'CASE 4 FAILED: expected retry-after of 1s for an event about to expire, got %', r;
  end if;
  raise notice 'CASE 4b: retry-after never rounds below 1 second — OK';
end $$;

-- ── case 4c: over the ceiling by MORE than one (e.g. the ceiling was lowered) — the wait is for the
--    (count - limit + 1)-th oldest event, not simply the oldest ────────────────────────────────────
reset role;
delete from public.ai_usage_events;
update public.ai_usage_limits set hourly_limit = 3, daily_limit = 100;
insert into public.ai_usage_events (user_id, feature, created_at)
select '00000000-0000-0000-0000-0000000009a1', 'plan', clock_timestamp() - make_interval(mins => m)
  from unnest(array[50, 40, 30, 20, 10]) m;                         -- 5 events inside the hour, limit 3
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000009a1', 'role', 'authenticated')::text, true);
do $$
declare r jsonb;
begin
  r := usagetest.reserve('plan');
  -- Allowed again only once the three oldest (50, 40, 30 min ago) have aged out: the 30-minute-old one
  -- expires in 30 minutes. (Waiting for just the oldest, 10 minutes away, would still be refused.)
  if (r ->> 'allowed')::boolean or (r ->> 'retry_after_seconds')::int not between 1790 and 1801 then
    raise exception 'CASE 4c FAILED: expected a ~30-minute wait, got %', r;
  end if;
  raise notice 'CASE 4c: when over the ceiling by several, the wait is for the event whose expiry actually frees a slot — OK';
end $$;

-- ── case 5: the daily ceiling (hourly set high so only the day window can refuse) ────────────────
reset role;
delete from public.ai_usage_events;                                  -- owner-only cleanup between cases
update public.ai_usage_limits set hourly_limit = 100, daily_limit = 5;
insert into public.ai_usage_events (user_id, feature, created_at)
select '00000000-0000-0000-0000-0000000009a1', 'plan', clock_timestamp() - make_interval(hours => h)
  from unnest(array[2, 5, 10, 20, 23]) h;                          -- 5 events inside the last 24h
insert into public.ai_usage_events (user_id, feature, created_at)
values ('00000000-0000-0000-0000-0000000009a1', 'plan', clock_timestamp() - interval '25 hours'),
       ('00000000-0000-0000-0000-0000000009a1', 'plan', clock_timestamp() - interval '48 hours');   -- outside: must not count
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000009a1', 'role', 'authenticated')::text, true);
do $$
declare r jsonb; n int;
begin
  r := usagetest.reserve('briefing_plan');
  if (r ->> 'allowed')::boolean or r ->> 'window' <> 'day' then
    raise exception 'CASE 5 FAILED: the daily ceiling should refuse (window day), got %', r;
  end if;
  -- It waits for the 23-hour-old event: about an hour.
  if (r ->> 'retry_after_seconds')::int not between 3500 and 3601 then
    raise exception 'CASE 5 FAILED: daily retry-after should be ~1h, got %', r;
  end if;
  select count(*) into n from public.ai_usage_events;
  if n <> 7 then raise exception 'CASE 5 FAILED: a refusal wrote a row'; end if;
  raise notice 'CASE 5a: the daily ceiling refuses; events older than 24h are ignored; exact daily retry-after — OK';
end $$;

reset role;
delete from public.ai_usage_events where created_at < clock_timestamp() - interval '24 hours';
delete from public.ai_usage_events where created_at = (select min(created_at) from public.ai_usage_events);  -- drop the 23h one
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000009a1', 'role', 'authenticated')::text, true);
do $$ begin
  if not usagetest.allowed('plan') then raise exception 'CASE 5 FAILED: under the daily ceiling a call should be allowed'; end if;
  raise notice 'CASE 5b: under the daily ceiling a call is allowed — OK';
end $$;

-- ── case 6: both ceilings exceeded → the LONGER wait is reported ─────────────────────────────────
reset role;
delete from public.ai_usage_events;
update public.ai_usage_limits set hourly_limit = 2, daily_limit = 3;
insert into public.ai_usage_events (user_id, feature, created_at) values
  ('00000000-0000-0000-0000-0000000009a1', 'plan', clock_timestamp() - interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000009a1', 'plan', clock_timestamp() - interval '5 minutes'),
  ('00000000-0000-0000-0000-0000000009a1', 'plan', clock_timestamp() - interval '23 hours');
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000009a1', 'role', 'authenticated')::text, true);
do $$
declare r jsonb;
begin
  r := usagetest.reserve('eod_review');
  -- hour: waits ~50 min for the 10-minute-old one; day: waits ~1h for the 23-hour-old one. Day is longer.
  if (r ->> 'allowed')::boolean or r ->> 'window' <> 'day' or (r ->> 'retry_after_seconds')::int not between 3500 and 3601 then
    raise exception 'CASE 6 FAILED: with both ceilings hit the longer (day) wait should be reported, got %', r;
  end if;
  raise notice 'CASE 6: with both ceilings exceeded the longer wait is reported — OK';
end $$;

-- ── case 7: ONE budget shared by every feature ───────────────────────────────────────────────────
reset role;
delete from public.ai_usage_events;
update public.ai_usage_limits set hourly_limit = 3, daily_limit = 100;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000009a1', 'role', 'authenticated')::text, true);
do $$
declare f text; n int;
begin
  foreach f in array array['plan', 'briefing_plan', 'eod_review'] loop
    if not usagetest.allowed(f) then raise exception 'CASE 7 FAILED: % should be allowed within the shared budget', f; end if;
  end loop;
  foreach f in array array['plan', 'briefing_plan', 'eod_review'] loop
    if usagetest.allowed(f) then raise exception 'CASE 7 FAILED: % got through after the shared budget was spent', f; end if;
  end loop;
  select count(distinct feature) into n from public.ai_usage_events;
  if n <> 3 then raise exception 'CASE 7 FAILED: expected one event per feature'; end if;
  raise notice 'CASE 7: plan + briefing_plan + eod_review draw on the SAME hourly budget — OK';
end $$;

-- ── case 8: users are independent ────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000009b2', 'role', 'authenticated')::text, true);
do $$
declare i int;
begin
  for i in 1..3 loop
    if not usagetest.allowed('plan') then raise exception 'CASE 8 FAILED: B was refused because of A''s usage'; end if;
  end loop;
  if usagetest.allowed('plan') then raise exception 'CASE 8 FAILED: B got a 4th call'; end if;
  raise notice 'CASE 8: A being at the ceiling does not affect B, and B has their own ceiling — OK';
end $$;

-- ── case 9: RLS / ownership / no direct writes ───────────────────────────────────────────────────
do $$
begin
  if (select count(*) from public.ai_usage_events) <> 3
     or exists (select 1 from public.ai_usage_events where user_id <> '00000000-0000-0000-0000-0000000009b2') then
    raise exception 'CASE 9 FAILED: B can see A''s usage rows';
  end if;
  raise notice 'CASE 9a: a user sees only their own usage events — OK';
end $$;
select usagetest.expect('CASE 9b: direct INSERT is refused (42501)',
  $$insert into public.ai_usage_events (user_id, feature) values ('00000000-0000-0000-0000-0000000009b2', 'plan')$$, '42501');
select usagetest.expect('CASE 9c: inserting a row for ANOTHER user is refused too (42501)',
  $$insert into public.ai_usage_events (user_id, feature) values ('00000000-0000-0000-0000-0000000009a1', 'plan')$$, '42501');
select usagetest.expect('CASE 9d: direct UPDATE is refused — events cannot be rewritten (42501)',
  $$update public.ai_usage_events set created_at = now() - interval '2 days'$$, '42501');
select usagetest.expect('CASE 9e: direct DELETE is refused — events cannot be erased (42501)',
  $$delete from public.ai_usage_events$$, '42501');
select usagetest.expect('CASE 9f: TRUNCATE is refused (42501)', $$truncate public.ai_usage_events$$, '42501');
select usagetest.expect('CASE 9g: the limits table cannot be read (42501)', $$select * from public.ai_usage_limits$$, '42501');
select usagetest.expect('CASE 9h: the limits table cannot be written — a user cannot raise their own ceiling (42501)',
  $$update public.ai_usage_limits set hourly_limit = 1000000$$, '42501');
select usagetest.expect('CASE 9i: the identity sequence is not usable (42501)',
  $$select nextval('public.ai_usage_events_id_seq')$$, '42501');

-- anon and service_role: no table access at all
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select usagetest.expect('CASE 9j: anon cannot read events (42501)', $$select * from public.ai_usage_events$$, '42501');
set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
select usagetest.expect('CASE 9k: service_role cannot read events (42501)', $$select * from public.ai_usage_events$$, '42501');
select usagetest.expect('CASE 9l: service_role cannot write events (42501)',
  $$insert into public.ai_usage_events (user_id, feature) values ('00000000-0000-0000-0000-0000000009b2', 'plan')$$, '42501');
select usagetest.expect('CASE 9m: service_role cannot read the limits (42501)', $$select * from public.ai_usage_limits$$, '42501');

-- ── case 10: shape and catalog facts ─────────────────────────────────────────────────────────────
reset role;
do $$
declare cols text;
begin
  -- No payload: the table holds a user, a feature and a time. Nothing else can be stored.
  select string_agg(column_name, ',' order by column_name) into cols
    from information_schema.columns where table_schema = 'public' and table_name = 'ai_usage_events';
  if cols <> 'created_at,feature,id,user_id' then
    raise exception 'CASE 10 FAILED: unexpected columns on ai_usage_events: %', cols;
  end if;
  raise notice 'CASE 10a: ai_usage_events holds only id, user_id, feature, created_at — OK';

  -- Every stored feature is one of the three enumerated values; the CHECK enforces it.
  begin
    insert into public.ai_usage_events (user_id, feature) values ('00000000-0000-0000-0000-0000000009a1', 'free text prompt');
    raise exception 'CASE 10 FAILED: a free-text feature was stored';
  exception when check_violation then null; end;
  raise notice 'CASE 10b: the feature column only accepts the three enumerated names — OK';

  -- The limits table is a singleton with positive ceilings.
  begin insert into public.ai_usage_limits (singleton, hourly_limit, daily_limit) values (false, 1, 1);
    raise exception 'CASE 10 FAILED: a second limits row was inserted';
  exception when check_violation then null; end;
  begin update public.ai_usage_limits set hourly_limit = 0; raise exception 'CASE 10 FAILED: a zero ceiling was accepted';
  exception when check_violation then null; end;
  begin insert into public.ai_usage_limits (hourly_limit, daily_limit) values (1, 1); raise exception 'CASE 10 FAILED: a duplicate singleton row';
  exception when unique_violation then null; end;
  raise notice 'CASE 10c: the limits table is a singleton with positive ceilings — OK';

  if not exists (select 1 from pg_proc p where p.oid = 'public.reserve_ai_call(text)'::regprocedure
                  and p.prosecdef and p.proconfig @> array['search_path=""']) then
    raise exception 'CASE 10 FAILED: reserve_ai_call is not SECURITY DEFINER with an empty search_path';
  end if;
  if has_function_privilege('anon', 'public.reserve_ai_call(text)', 'execute')
     or has_function_privilege('service_role', 'public.reserve_ai_call(text)', 'execute')
     or has_function_privilege('public', 'public.reserve_ai_call(text)', 'execute')
     or not has_function_privilege('authenticated', 'public.reserve_ai_call(text)', 'execute') then
    raise exception 'CASE 10 FAILED: reserve_ai_call has the wrong EXECUTE grants';
  end if;
  raise notice 'CASE 10d: reserve_ai_call is SECURITY DEFINER, search_path = '''', authenticated-only — OK';

  if has_table_privilege('authenticated', 'public.ai_usage_events', 'insert')
     or has_table_privilege('authenticated', 'public.ai_usage_events', 'update')
     or has_table_privilege('authenticated', 'public.ai_usage_events', 'delete')
     or has_table_privilege('authenticated', 'public.ai_usage_events', 'truncate')
     or has_table_privilege('anon', 'public.ai_usage_events', 'select')
     or has_table_privilege('service_role', 'public.ai_usage_events', 'select')
     or has_table_privilege('authenticated', 'public.ai_usage_limits', 'select')
     or has_table_privilege('anon', 'public.ai_usage_limits', 'select')
     or has_table_privilege('service_role', 'public.ai_usage_limits', 'select') then
    raise exception 'CASE 10 FAILED: a table grant is wider than intended';
  end if;
  raise notice 'CASE 10e: no write grant to any API role; limits table closed to all of them — OK';
end $$;

-- ── case 11: the stored identity is always the caller's — there is no way to name someone else ───
do $$
declare uid_ok int;
begin
  select count(*) into uid_ok from public.ai_usage_events
   where user_id in ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-0000000009b2');
  -- (the reserve_ai_call signature takes no user id: checked structurally)
  if (select pronargs from pg_proc where oid = 'public.reserve_ai_call(text)'::regprocedure) <> 1 then
    raise exception 'CASE 11 FAILED: reserve_ai_call takes more than the feature name';
  end if;
  raise notice 'CASE 11: reserve_ai_call takes ONE argument (the feature); identity is auth.uid() only — OK';
end $$;

rollback;

select 'AI USAGE ISOLATION OK' as result;
