-- ─────────────────────────────────────────────────────────────────────────
-- RLS isolation check for Phase 3.
--
-- NOT executed as part of `npm test` — it needs a real Postgres instance
-- with this migration applied (the sandbox this was written in has no
-- Docker/Supabase CLI, so this file is unverified; review it before relying
-- on it). Run it against a local Supabase stack:
--
--   supabase start
--   supabase db reset            # applies supabase/migrations/*
--   psql "$(supabase status -o env | grep DB_URL | cut -d= -f2)" \
--        -f supabase/tests/rls_isolation.sql
--
-- It creates two throwaway auth.users rows, impersonates each via the same
-- `request.jwt.claims` GUC that PostgREST sets on a real request (which is
-- what auth.uid() reads), and asserts user B can neither see nor mutate
-- user A's rows. Everything runs inside one transaction and is rolled back
-- at the end, so it never leaves data behind. Prints "RLS ISOLATION OK" on
-- success; any failed assertion raises and aborts the transaction.
-- ─────────────────────────────────────────────────────────────────────────

begin;

-- Fixture users. Only the columns RLS/foreign keys actually need.
insert into auth.users (id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'user-a@example.test', '', now(), now()),
  ('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'authenticated', 'user-b@example.test', '', now(), now());

-- ── Act as user A: create a day, a task, a briefing, a plan ────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);

insert into public.profiles (id, timezone)
values ('00000000-0000-0000-0000-0000000000a1', 'UTC');

insert into public.days (id, user_id, local_date, timezone)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '2026-09-22', 'UTC');

insert into public.briefings (user_id, day_id, raw_text)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'Finish the report.');

insert into public.plans (id, user_id, day_id)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1');

insert into public.plan_revisions (plan_id, user_id, revision_number, source)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 1, 'system');

select public.create_task_with_history(
  '00000000-0000-0000-0000-0000000000d1',
  'Write the report', null, 'high', 'flexible',
  now(), now() + interval '30 minutes', null, 'user'
);

do $$
begin
  if (select count(*) from public.tasks where user_id = '00000000-0000-0000-0000-0000000000a1') <> 1 then
    raise exception 'setup failed: user A should own exactly one task';
  end if;
end $$;

-- Remember user A's real task id (transaction-local) *while acting as A*. Once we switch to
-- user B below, RLS hides this row from B, so looking it up there would hand the RPC a NULL
-- and the cross-user check would prove nothing.
select set_config('test.task_a_id',
  (select id::text from public.tasks where user_id = '00000000-0000-0000-0000-0000000000a1'),
  true);

-- ── Act as user B: attempt to read/mutate user A's rows ─────────────────
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text,
  true);

do $$
begin
  if exists (select 1 from public.days where user_id = '00000000-0000-0000-0000-0000000000a1') then
    raise exception 'RLS FAILED: user B can see user A''s days';
  end if;
  if exists (select 1 from public.tasks where user_id = '00000000-0000-0000-0000-0000000000a1') then
    raise exception 'RLS FAILED: user B can see user A''s tasks';
  end if;
  if exists (select 1 from public.briefings where user_id = '00000000-0000-0000-0000-0000000000a1') then
    raise exception 'RLS FAILED: user B can see user A''s briefings';
  end if;
  if exists (select 1 from public.plans where user_id = '00000000-0000-0000-0000-0000000000a1') then
    raise exception 'RLS FAILED: user B can see user A''s plans';
  end if;
  if exists (select 1 from public.plan_revisions where user_id = '00000000-0000-0000-0000-0000000000a1') then
    raise exception 'RLS FAILED: user B can see user A''s plan revisions';
  end if;
end $$;

-- A direct UPDATE against user A's task must affect zero rows under RLS.
update public.tasks
   set title = 'hijacked by B'
 where user_id = '00000000-0000-0000-0000-0000000000a1';

do $$
begin
  if (select title from public.tasks where user_id = '00000000-0000-0000-0000-0000000000a1') = 'hijacked by B' then
    raise exception 'RLS FAILED: user B mutated user A''s task';
  end if;
end $$;

-- user B must not be able to change user A's task through the RPC. Targets A's *real* task id
-- (captured above). The flag records an unexpected success; the handler catches ONLY the one
-- expected refusal (P0002 / no_data_found: the RPC found no upcoming row owned by the caller), so
-- any other error still aborts the test instead of being swallowed. The assertion itself runs
-- AFTER the exception block, where the handler cannot catch it.
do $$
declare
  v_task_a_id uuid := current_setting('test.task_a_id')::uuid;
  v_result public.tasks;
  v_unexpectedly_succeeded boolean := false;
begin
  begin
    select * into v_result from public.change_task_status(v_task_a_id, 'completed');
    v_unexpectedly_succeeded := true;
  exception
    when sqlstate 'P0002' then
      null; -- expected: user B is refused
  end;

  if v_unexpectedly_succeeded then
    raise exception 'RLS FAILED: user B completed user A''s task via change_task_status()';
  end if;
end $$;

-- User B genuinely has none of user A's data, and their own scoped queries
-- (which would return zero rows here, since B created nothing) don't error.
do $$
begin
  if (select count(*) from public.days) <> 0 then
    raise exception 'RLS FAILED: user B''s day count should be 0, saw a leaked row';
  end if;
end $$;

do $$
begin
  raise notice 'RLS ISOLATION OK';
end $$;

rollback;
