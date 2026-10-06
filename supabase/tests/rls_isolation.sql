-- ─────────────────────────────────────────────────────────────────────────
-- Cross-user isolation check against the CURRENT security model (Phase 3 RLS + the Phase 4.1b write
-- lockdown + every table added since).
--
-- This file used to build its fixtures with direct INSERTs into `days`, `plans` and `plan_revisions`,
-- which Phase 4.1b deliberately closed, so it could not run past its own setup. Its INTENT — "user B
-- can neither see nor change user A's data" — is exactly what still has to hold, so it is rewritten
-- rather than retired: fixtures are built the way the app builds them (the SECURITY DEFINER RPCs),
-- and the assertions cover every user-owned table, direct writes, cross-user RPC calls, and anon.
--
-- Same technique as the other files here: throwaway auth.users rows, impersonated via the
-- `request.jwt.claims` GUC, everything inside ONE transaction and rolled back. Run it against a real
-- Postgres whose roles mirror Supabase's, with every migration applied:
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_isolation.sql
--
-- The per-table detail (grants, constraints, RPC edge cases) lives in the per-feature suites; this is
-- the one place that asserts the single property across ALL of them at once.
-- ─────────────────────────────────────────────────────────────────────────

begin;

insert into auth.users (id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'rls-a@example.test', '', now(), now()),
  ('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'authenticated', 'rls-b@example.test', '', now(), now());

create schema rlstest;
grant usage on schema rlstest to public;

create function rlstest.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

create function rlstest.expect(p_label text, p_sql text, p_state text) returns void
language plpgsql as $$
declare got text := rlstest.try(p_sql);
begin
  if got is distinct from p_state then
    raise exception '% FAILED: expected %, got %', p_label, p_state, got;
  end if;
  raise notice '% — OK', p_label;
end;
$$;

-- How many rows of `p_table` carry `p_owner_col = p_owner` as seen by the CURRENT role, or -1 if the
-- role has no privilege to read the table at all (either way: nothing leaked).
create function rlstest.visible(p_table text, p_owner_col text, p_owner uuid) returns bigint
language plpgsql as $$
declare n bigint;
begin
  execute format('select count(*) from public.%I where %I = %L', p_table, p_owner_col, p_owner) into n;
  return n;
exception when insufficient_privilege then
  return -1;
end;
$$;
grant execute on all functions in schema rlstest to public;

-- ── user A builds a realistic footprint, through the same RPCs the app uses ────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);

insert into public.profiles (id, timezone) values ('00000000-0000-0000-0000-0000000000a1', 'UTC');
select * from public.ensure_day() \gset a_day_
insert into public.briefings (user_id, day_id, raw_text)
values ('00000000-0000-0000-0000-0000000000a1', :'a_day_id', 'Finish the report.');
select id as a_task from public.create_task_with_history(:'a_day_id', 'Write the report', null, 'high', 'flexible',
  now(), now() + interval '30 minutes', null, 'user') \gset
select id as a_prop from public.create_ai_proposal(:'a_day_id', 1, 'typed', 'move it', 'ok', '[]', '[]', '[]', '[]', 'invalid') \gset
select id as a_sub from public.register_push_subscription('https://push.example.test/rls-a', 'p256dh-a', 'auth-a') \gset
select public.reserve_ai_call('plan') as a_reserved \gset
select set_config('test.a_day', :'a_day_id', true), set_config('test.a_task', :'a_task', true),
       set_config('test.a_prop', :'a_prop', true), set_config('test.a_sub', :'a_sub', true) \gset

do $$
begin
  if (select count(*) from public.tasks) <> 1 or (select count(*) from public.days) <> 1
     or (select count(*) from public.briefings) <> 1 or (select count(*) from public.ai_proposals) <> 1
     or (select count(*) from public.push_subscriptions) <> 1 or (select count(*) from public.ai_usage_events) <> 1 then
    raise exception 'fixture: user A should own exactly one of each';
  end if;
end $$;

-- ── user B (a real, fully set-up user with their own day) ───────────────────────────────────────
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text, true);
insert into public.profiles (id, timezone) values ('00000000-0000-0000-0000-0000000000b2', 'UTC');
select * from public.ensure_day() \gset b_day_
select set_config('test.b_day', :'b_day_id', true) \gset

-- 1. B sees NONE of A's rows, in any table that holds user data.
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-0000000000a1';
  t record;
begin
  for t in select * from (values
      ('profiles', 'id'), ('days', 'user_id'), ('plans', 'user_id'), ('plan_revisions', 'user_id'),
      ('tasks', 'user_id'), ('task_history', 'user_id'), ('briefings', 'user_id'),
      ('ai_proposals', 'user_id'), ('eod_reports', 'user_id'), ('push_subscriptions', 'user_id'),
      ('scheduled_notifications', 'user_id'), ('ai_usage_events', 'user_id')
    ) as x(tbl, col) loop
    if rlstest.visible(t.tbl, t.col, a) > 0 then
      raise exception 'CASE 1 FAILED: user B can see user A''s rows in public.%', t.tbl;
    end if;
  end loop;
  raise notice 'CASE 1: B sees none of A''s rows in any of the 12 user-data tables — OK';

  if (select count(*) from public.days) <> 1 or (select count(*) from public.profiles) <> 1 then
    raise exception 'CASE 1 FAILED: B''s unscoped reads should return only B''s own rows';
  end if;
  raise notice 'CASE 1b: unscoped reads return only the caller''s own rows — OK';
end $$;

-- 2. Direct writes are refused for the locked tables (lack of PRIVILEGE, not merely filtered by RLS),
--    for B against A's rows AND against anything at all.
do $$
declare t text;
begin
  foreach t in array array['days', 'plans', 'plan_revisions', 'tasks', 'task_history', 'ai_proposals',
                           'eod_reports', 'push_subscriptions', 'scheduled_notifications', 'ai_usage_events'] loop
    perform rlstest.expect('CASE 2a: direct INSERT into ' || t || ' refused (42501)',
      format('insert into public.%I default values', t), '42501');
    perform rlstest.expect('CASE 2b: direct UPDATE of ' || t || ' refused (42501)',
      format('update public.%I set user_id = user_id', t), '42501');
    perform rlstest.expect('CASE 2c: direct DELETE from ' || t || ' refused (42501)',
      format('delete from public.%I', t), '42501');
  end loop;
end $$;

-- 2d. The privilege layer, asserted on its own. A refused INSERT/UPDATE/DELETE above could be the
--     privilege check OR a missing RLS policy (both are 42501), and an anon READ could be stopped by RLS
--     alone — so each layer is checked independently here: if either were loosened, the other would
--     still hold, but the regression must not go unnoticed.
do $$
declare
  t text;
  fn record;
  locked constant text[] := array['days', 'plans', 'plan_revisions', 'tasks', 'task_history', 'ai_proposals',
                                  'eod_reports', 'push_subscriptions', 'scheduled_notifications', 'ai_usage_events'];
begin
  foreach t in array locked loop
    if has_table_privilege('authenticated', 'public.' || t, 'insert')
       or has_table_privilege('authenticated', 'public.' || t, 'update')
       or has_table_privilege('authenticated', 'public.' || t, 'delete')
       or has_table_privilege('authenticated', 'public.' || t, 'truncate') then
      raise exception 'CASE 2d FAILED: authenticated holds a WRITE privilege on public.%', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('anon', 'public.' || t, 'insert')
       or has_table_privilege('anon', 'public.' || t, 'update') or has_table_privilege('anon', 'public.' || t, 'delete') then
      raise exception 'CASE 2d FAILED: anon holds a privilege on public.%', t;
    end if;
  end loop;
  raise notice 'CASE 2d: on the 10 locked tables authenticated has no write privilege and anon has no privilege at all — OK';

  for fn in select p.oid::regprocedure::text as sig, p.oid
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname <> 'set_updated_at' loop
    if has_function_privilege('anon', fn.oid, 'execute') or has_function_privilege('public', fn.oid, 'execute') then
      raise exception 'CASE 2e FAILED: anon/PUBLIC can EXECUTE %', fn.sig;
    end if;
  end loop;
  raise notice 'CASE 2e: no public function (bar the trigger function) is executable by anon or PUBLIC — OK';
end $$;

-- 3. The two tables users may write directly (profiles, briefings) are still owner-scoped by RLS.
do $$
declare a constant uuid := '00000000-0000-0000-0000-0000000000a1';
begin
  perform rlstest.expect('CASE 3a: B cannot create a briefing owned by A (RLS check, 42501)',
    format('insert into public.briefings (user_id, day_id, raw_text) values (%L, %L, %L)',
           a, current_setting('test.a_day'), 'forged'), '42501');
  -- B may write rows of their OWN to the two directly-writable tables. Whatever B attaches to A's day
  -- id (an unguessable uuid) is B's row, and must never become visible to, or alter, A's data: A's
  -- unchanged view is asserted in CASE 6. These statements are not asserted to succeed or fail.
  perform rlstest.try(format('insert into public.briefings (user_id, day_id, raw_text) values (%L, %L, %L)',
           '00000000-0000-0000-0000-0000000000b2', current_setting('test.a_day'), 'sneaky'));
  perform rlstest.try(format('update public.briefings set raw_text = %L where user_id = %L', 'hijacked', a));
  perform rlstest.try(format('update public.profiles set timezone = %L where id = %L', 'Pacific/Kiritimati', a));
  perform rlstest.try(format('delete from public.briefings where user_id = %L', a));
  perform rlstest.expect('CASE 3c: B cannot create a profile for A (RLS check, 42501)',
    format('insert into public.profiles (id, timezone) values (%L, %L)', a, 'UTC'), '42501');
  perform rlstest.expect('CASE 3d: B cannot create a profile for a third user (RLS, 42501)',
    format('insert into public.profiles (id, timezone) values (%L, %L)', gen_random_uuid(), 'UTC'), '42501');
  raise notice 'CASE 3e: B''s writes to briefings/profiles were attempted; A''s view is verified unchanged below — OK';
end $$;

-- 4. Every RPC refuses B on A's objects, and changes nothing.
do $$
declare
  a_day uuid := current_setting('test.a_day')::uuid;
  a_task uuid := current_setting('test.a_task')::uuid;
  a_prop uuid := current_setting('test.a_prop')::uuid;
begin
  perform rlstest.expect('CASE 4a: change_task_status on A''s task → P0002',
    format('select public.change_task_status(%L, %L)', a_task, 'completed'), 'P0002');
  perform rlstest.expect('CASE 4b: reschedule_task on A''s task → P0002',
    format('select public.reschedule_task(%L, now(), now() + interval ''20 minutes'')', a_task), 'P0002');
  perform rlstest.expect('CASE 4c: apply_replan on A''s day → P0002',
    format($f$select public.apply_replan(%L, jsonb_build_array(jsonb_build_object('task_id', %L, 'previous_start', now(),
      'previous_end', now() + interval '30 minutes', 'previous_unscheduled', false, 'new_start', now(),
      'new_end', now() + interval '30 minutes', 'new_unscheduled', true)))$f$, a_day, a_task), 'P0002');
  perform rlstest.expect('CASE 4d: create_task_with_history into A''s day → P0002',
    format('select public.create_task_with_history(%L, %L, null, %L, %L, now(), now() + interval ''10 minutes'', null, %L)',
           a_day, 'intruder', 'low', 'flexible', 'user'), 'P0002');
  perform rlstest.expect('CASE 4e: create_ai_proposal on A''s day → P0002',
    format($f$select public.create_ai_proposal(%L, 1, 'typed', 't', 'u', '[]', '[]', '[]', '[]', 'invalid')$f$, a_day), 'P0002');
  perform rlstest.expect('CASE 4f: confirm_ai_proposal with an empty change list → 22023 (shape is checked before ownership)',
    format($f$select public.confirm_ai_proposal(%L, 1, '[]'::jsonb)$f$, a_day), '22023');
  -- ^ an empty change list is refused by shape before ownership is even looked at; the next two cases
  --   use a well-formed list so the OWNERSHIP check is what refuses:
  perform rlstest.expect('CASE 4g: confirm_ai_proposal (well-formed) on A''s day → P0002',
    format($f$select public.confirm_ai_proposal(%L, 1, jsonb_build_array(jsonb_build_object('ref','t1','task_id',%L,'type','unschedule')))$f$,
           a_day, a_task), 'P0002');
  perform rlstest.expect('CASE 4h: confirm_ai_proposal_by_id on A''s proposal → P0002',
    format('select public.confirm_ai_proposal_by_id(%L)', a_prop), 'P0002');
  perform rlstest.expect('CASE 4i: discarding A''s proposal is a silent no-op (never reveals it exists)',
    format('select public.discard_ai_proposal(%L)', a_prop), 'ok');
  perform rlstest.expect('CASE 4j: revoking A''s push subscription by endpoint is a silent no-op',
    $f$select public.revoke_push_subscription('https://push.example.test/rls-a')$f$, 'ok');
end $$;

-- 5. anon: nothing readable, nothing writable, no RPC.
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
declare t record;
begin
  for t in select * from (values
      ('profiles', 'id'), ('days', 'user_id'), ('plans', 'user_id'), ('plan_revisions', 'user_id'),
      ('tasks', 'user_id'), ('task_history', 'user_id'), ('briefings', 'user_id'),
      ('ai_proposals', 'user_id'), ('eod_reports', 'user_id'), ('push_subscriptions', 'user_id'),
      ('scheduled_notifications', 'user_id'), ('ai_usage_events', 'user_id')
    ) as x(tbl, col) loop
    if rlstest.visible(t.tbl, t.col, '00000000-0000-0000-0000-0000000000a1') > 0
       or rlstest.visible(t.tbl, t.col, '00000000-0000-0000-0000-0000000000b2') > 0 then
      raise exception 'CASE 5 FAILED: anon can see rows in public.%', t.tbl;
    end if;
  end loop;
  raise notice 'CASE 5a: anon sees no row in any user-data table — OK';
end $$;
select rlstest.expect('CASE 5b: anon cannot write a briefing (42501)',
  $$insert into public.briefings (user_id, day_id, raw_text) values (gen_random_uuid(), gen_random_uuid(), 'x')$$, '42501');
select rlstest.expect('CASE 5c: anon cannot call ensure_day (42501)', $$select public.ensure_day()$$, '42501');
select rlstest.expect('CASE 5d: anon cannot reserve AI budget (42501)', $$select public.reserve_ai_call('plan')$$, '42501');

-- 6. Back as A: everything is exactly as A left it — B's attempts changed nothing, B's one allowed
--    write (a briefing of their own) is invisible to A.
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
do $$
begin
  if (select raw_text from public.briefings) <> 'Finish the report.' or (select count(*) from public.briefings) <> 1 then
    raise exception 'CASE 6 FAILED: A''s briefing was changed, deleted or joined by another user''s';
  end if;
  if (select timezone from public.profiles) <> 'UTC' then raise exception 'CASE 6 FAILED: A''s profile was changed'; end if;
  if (select status from public.tasks) <> 'upcoming' or (select title from public.tasks) <> 'Write the report' then
    raise exception 'CASE 6 FAILED: A''s task was changed';
  end if;
  if (select status from public.ai_proposals) <> 'generated' then raise exception 'CASE 6 FAILED: A''s proposal was changed'; end if;
  if (select revoked_at from public.push_subscriptions) is not null then raise exception 'CASE 6 FAILED: A''s push subscription was revoked'; end if;
  if (select count(*) from public.plan_revisions) <> 1 then raise exception 'CASE 6 FAILED: a revision was written on A''s plan'; end if;
  if (select count(*) from public.ai_usage_events) <> 1 then raise exception 'CASE 6 FAILED: A''s usage was changed'; end if;
  raise notice 'CASE 6: A''s data is exactly as A left it — OK';
end $$;

do $$ begin raise notice 'RLS ISOLATION OK'; end $$;

rollback;
