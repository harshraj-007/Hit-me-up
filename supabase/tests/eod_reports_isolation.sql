-- ─────────────────────────────────────────────────────────────────────────
-- End-of-day report isolation / integrity check for Phase 7 (eod_reports + create_eod_report).
--
-- Same technique as the other files in this directory: throwaway auth.users rows, impersonated via
-- the `request.jwt.claims` GUC, everything inside ONE transaction, rolled back at the end. Run it
-- against a real Postgres whose roles mirror Supabase's, with every migration applied:
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/eod_reports_isolation.sql
--
-- Covers: ownership isolation (RLS + the RPC's own day-ownership check), unauthenticated / anon /
-- service_role access, no direct writes, malformed input, the day-must-have-started rule, replay
-- idempotency, append-only behavior, the per-day cap, and the catalog facts (SECURITY DEFINER,
-- search_path, grants). Concurrent creation needs two real connections and is exercised by
-- supabase/tests/concurrent_eod_reports.sh.
-- ─────────────────────────────────────────────────────────────────────────

begin;

insert into auth.users (id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('00000000-0000-0000-0000-0000000000e1', 'authenticated', 'authenticated', 'eod-a@example.test', '', now(), now()),
  ('00000000-0000-0000-0000-0000000000e2', 'authenticated', 'authenticated', 'eod-b@example.test', '', now(), now());

-- Helpers live in a throwaway schema (rolled back with everything else). SECURITY INVOKER, so the
-- role being tested is exactly the one whose privileges apply.
create schema eodtest;
grant usage on schema eodtest to public;

create function eodtest.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

create function eodtest.expect(p_label text, p_sql text, p_state text) returns void
language plpgsql as $$
declare got text := eodtest.try(p_sql);
begin
  if got is distinct from p_state then
    raise exception '% FAILED: expected %, got %', p_label, p_state, got;
  end if;
  raise notice '% — OK', p_label;
end;
$$;

-- SQL text for one create_eod_report call, values taken verbatim (so NULLs and junk can be tried).
create function eodtest.call(p_day uuid, p_fp text, p_version text, p_facts jsonb, p_interp jsonb)
returns text language sql as $$
  select format('select public.create_eod_report(%L, %L, %L, %L::jsonb, %L::jsonb)',
                p_day, p_fp, p_version, p_facts, p_interp)
$$;
grant execute on all functions in schema eodtest to public;

-- ── fixtures: A has today + a future day; B has today ───────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000e1', 'role', 'authenticated')::text, true);
insert into public.profiles (id, timezone) values ('00000000-0000-0000-0000-0000000000e1', 'UTC');
select * from public.ensure_day() \gset a_day_
select * from public.ensure_day((current_date + 3)::date) \gset a_future_

select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000e2', 'role', 'authenticated')::text, true);
insert into public.profiles (id, timezone) values ('00000000-0000-0000-0000-0000000000e2', 'UTC');
select * from public.ensure_day() \gset b_day_

-- Bridge psql-side values into GUCs, because psql variables do not expand inside DO $$ bodies.
select set_config('test.a_day', :'a_day_id', true),
       set_config('test.a_future', :'a_future_id', true),
       set_config('test.b_day', :'b_day_id', true),
       set_config('test.date', :'a_day_local_date', true),
       set_config('test.b_date', :'b_day_local_date', true) \gset

-- ── Cases 1–3, 5–7 (as A): create, replay, append, malformed input, future day, ownership ───
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000e1', 'role', 'authenticated')::text, true);

do $$
declare
  d      uuid := current_setting('test.a_day')::uuid;
  facts  jsonb := jsonb_build_object(
           'planningDate', current_setting('test.date'), 'timezone', 'UTC',
           'asOf', current_setting('test.date') || 'T21:00',
           'tasks', jsonb_build_array(jsonb_build_object('ref', 't1', 'title', 'Write report')),
           'totals', jsonb_build_object('total', 1));
  interp jsonb := jsonb_build_object(
           'summary', 'A calm day.', 'takeaway', 'Start earlier.',
           'patterns', jsonb_build_array(), 'carryForward', jsonb_build_array());
  fp1 text := repeat('a', 64);
  fp2 text := repeat('b', 64);
  r1 public.eod_reports; r2 public.eod_reports; r3 public.eod_reports;
  n int;
  big_tasks jsonb;
begin
  -- 1. Owner creates a report; it is filed under the caller and the named day.
  select * into r1 from public.create_eod_report(d, fp1, 'v1', facts, interp);
  if r1.user_id <> '00000000-0000-0000-0000-0000000000e1' or r1.day_id <> d then
    raise exception 'CASE 1 FAILED: report not filed under the caller/day';
  end if;
  raise notice 'CASE 1: owner creates a report — OK';

  -- 2. Replay with the same fingerprint is idempotent: same row, nothing new, FIRST report stands.
  select * into r2 from public.create_eod_report(
    d, fp1, 'v1', facts, interp || jsonb_build_object('summary', 'A different narrative.'));
  select count(*) into n from public.eod_reports where day_id = d;
  if r2.id <> r1.id or n <> 1 or r2.interpretation ->> 'summary' <> 'A calm day.' then
    raise exception 'CASE 2 FAILED: replay was not idempotent (rows=%)', n;
  end if;
  raise notice 'CASE 2: replaying the same day-state returns the existing report, writes nothing — OK';

  -- 3. A different day-state appends a NEW row; the old one remains untouched (append-only).
  select * into r3 from public.create_eod_report(d, fp2, 'v1', facts, interp);
  select count(*) into n from public.eod_reports where day_id = d;
  if r3.id = r1.id or n <> 2
     or (select interpretation ->> 'summary' from public.eod_reports where id = r1.id) <> 'A calm day.' then
    raise exception 'CASE 3 FAILED: a changed day did not append a new report (rows=%)', n;
  end if;
  raise notice 'CASE 3: a changed day appends a new report; the old one is untouched — OK';

  -- 5. Malformed input is refused with 22023 and nothing is written.
  perform eodtest.expect('CASE 5a: fingerprint wrong format', eodtest.call(d, 'xyz', 'v1', facts, interp), '22023');
  perform eodtest.expect('CASE 5b: fingerprint NULL', eodtest.call(d, null, 'v1', facts, interp), '22023');
  perform eodtest.expect('CASE 5c: fingerprint uppercase hex', eodtest.call(d, repeat('A', 64), 'v1', facts, interp), '22023');
  perform eodtest.expect('CASE 5d: prompt version has illegal characters', eodtest.call(d, repeat('c', 64), 'bad version!', facts, interp), '22023');
  perform eodtest.expect('CASE 5e: prompt version NULL', eodtest.call(d, repeat('c', 64), null, facts, interp), '22023');
  perform eodtest.expect('CASE 5f: facts NULL', eodtest.call(d, repeat('c', 64), 'v1', null, interp), '22023');
  perform eodtest.expect('CASE 5g: facts is an array', eodtest.call(d, repeat('c', 64), 'v1', '[]'::jsonb, interp), '22023');
  perform eodtest.expect('CASE 5h: facts has no tasks', eodtest.call(d, repeat('c', 64), 'v1', facts - 'tasks', interp), '22023');
  perform eodtest.expect('CASE 5i: facts has an EMPTY task list (an empty day is never stored)',
    eodtest.call(d, repeat('c', 64), 'v1', jsonb_set(facts, '{tasks}', '[]'), interp), '22023');
  select jsonb_agg(jsonb_build_object('ref', 't' || g)) into big_tasks from generate_series(1, 101) g;
  perform eodtest.expect('CASE 5j: facts has 101 tasks', eodtest.call(d, repeat('c', 64), 'v1', jsonb_set(facts, '{tasks}', big_tasks), interp), '22023');
  perform eodtest.expect('CASE 5k: facts has no totals', eodtest.call(d, repeat('c', 64), 'v1', facts - 'totals', interp), '22023');
  perform eodtest.expect('CASE 5l: facts.totals is not an object', eodtest.call(d, repeat('c', 64), 'v1', jsonb_set(facts, '{totals}', '"x"'), interp), '22023');
  perform eodtest.expect('CASE 5m: facts describe a DIFFERENT date than the day they are filed under',
    eodtest.call(d, repeat('c', 64), 'v1', jsonb_set(facts, '{planningDate}', '"1999-01-01"'), interp), '22023');
  perform eodtest.expect('CASE 5n: facts carry a different timezone than the day',
    eodtest.call(d, repeat('c', 64), 'v1', jsonb_set(facts, '{timezone}', '"Asia/Tokyo"'), interp), '22023');
  perform eodtest.expect('CASE 5o: facts larger than 64 KiB',
    eodtest.call(d, repeat('c', 64), 'v1', jsonb_set(facts, '{tasks}', jsonb_build_array(jsonb_build_object('title', repeat('x', 70000)))), interp), '22023');
  perform eodtest.expect('CASE 5p: interpretation NULL', eodtest.call(d, repeat('c', 64), 'v1', facts, null), '22023');
  perform eodtest.expect('CASE 5q: interpretation is an array', eodtest.call(d, repeat('c', 64), 'v1', facts, '[]'::jsonb), '22023');
  perform eodtest.expect('CASE 5r: interpretation has no summary', eodtest.call(d, repeat('c', 64), 'v1', facts, interp - 'summary'), '22023');
  perform eodtest.expect('CASE 5s: summary is empty', eodtest.call(d, repeat('c', 64), 'v1', facts, jsonb_set(interp, '{summary}', '""')), '22023');
  perform eodtest.expect('CASE 5t: summary longer than 400 characters', eodtest.call(d, repeat('c', 64), 'v1', facts, jsonb_set(interp, '{summary}', to_jsonb(repeat('s', 401)))), '22023');
  perform eodtest.expect('CASE 5u: takeaway longer than 200 characters', eodtest.call(d, repeat('c', 64), 'v1', facts, jsonb_set(interp, '{takeaway}', to_jsonb(repeat('t', 201)))), '22023');
  perform eodtest.expect('CASE 5v: summary is not a string', eodtest.call(d, repeat('c', 64), 'v1', facts, jsonb_set(interp, '{summary}', '42')), '22023');
  perform eodtest.expect('CASE 5w: four patterns',
    eodtest.call(d, repeat('c', 64), 'v1', facts, jsonb_set(interp, '{patterns}', '[{},{},{},{}]')), '22023');
  perform eodtest.expect('CASE 5x: six carry-forward entries',
    eodtest.call(d, repeat('c', 64), 'v1', facts, jsonb_set(interp, '{carryForward}', '[{},{},{},{},{},{}]')), '22023');
  perform eodtest.expect('CASE 5y: patterns is not an array', eodtest.call(d, repeat('c', 64), 'v1', facts, jsonb_set(interp, '{patterns}', '"x"')), '22023');
  perform eodtest.expect('CASE 5z: interpretation larger than 16 KiB',
    eodtest.call(d, repeat('c', 64), 'v1', facts, jsonb_set(interp, '{patterns}', jsonb_build_array(jsonb_build_object('text', repeat('p', 17000))))), '22023');
  select count(*) into n from public.eod_reports where day_id = d;
  if n <> 2 then raise exception 'CASE 5 FAILED: malformed input wrote a row (rows=%)', n; end if;

  -- 6. A day that has not started yet cannot be reviewed.
  perform eodtest.expect('CASE 6: a future day is refused',
    eodtest.call(current_setting('test.a_future')::uuid, repeat('d', 64), 'v1',
      jsonb_set(facts, '{planningDate}', to_jsonb((current_date + 3)::text)), interp), '22023');

  -- 7. Ownership inside the RPC itself: unknown id and another user's day look identical.
  perform eodtest.expect('CASE 7a: unknown day id', eodtest.call(gen_random_uuid(), repeat('e', 64), 'v1', facts, interp), 'P0002');
  perform eodtest.expect('CASE 7b: another user''s day (filed under A, owned by B)',
    eodtest.call(current_setting('test.b_day')::uuid, repeat('e', 64), 'v1', facts, interp), 'P0002');

  -- 8. The per-day cap: 18 more distinct states reach 20; the 21st is refused; a replay of an
  --    existing one still succeeds at the cap.
  for i in 1..18 loop
    perform public.create_eod_report(d, lpad(to_hex(1000 + i), 64, '0'), 'v1', facts, interp);
  end loop;
  select count(*) into n from public.eod_reports where day_id = d;
  if n <> 20 then raise exception 'CASE 8 FAILED: expected 20 reports, got %', n; end if;
  perform eodtest.expect('CASE 8a: the 21st distinct report is refused', eodtest.call(d, repeat('f', 64), 'v1', facts, interp), '54000');
  perform eodtest.expect('CASE 8b: replaying an existing report still works at the cap', eodtest.call(d, fp1, 'v1', facts, interp), 'ok');
end $$;

-- ── Case 9: no direct writes, even on the caller's own rows ─────────────────────────────────
do $$
begin
  perform eodtest.expect('CASE 9a: direct INSERT is denied',
    format('insert into public.eod_reports (user_id, day_id, state_fingerprint, prompt_version, facts, interpretation) values (%L, %L, %L, %L, %L, %L)',
      '00000000-0000-0000-0000-0000000000e1', current_setting('test.a_day'), repeat('9', 64), 'v1', '{}', '{}'), '42501');
  perform eodtest.expect('CASE 9b: direct UPDATE is denied', 'update public.eod_reports set prompt_version = ''hacked''', '42501');
  perform eodtest.expect('CASE 9c: direct DELETE is denied', 'delete from public.eod_reports', '42501');
  perform eodtest.expect('CASE 9d: TRUNCATE is denied', 'truncate public.eod_reports', '42501');
  if (select count(*) from public.eod_reports where prompt_version = 'hacked') <> 0 then
    raise exception 'CASE 9 FAILED: a direct UPDATE changed a report';
  end if;
  if (select count(*) from public.eod_reports) <> 20 then
    raise exception 'CASE 9 FAILED: A should see exactly their own 20 reports';
  end if;
  raise notice 'CASE 9: A sees exactly their own reports and cannot write any directly — OK';
end $$;

-- ── Case 10: user B is isolated from A ──────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000e2', 'role', 'authenticated')::text, true);
do $$
declare
  b_facts jsonb := jsonb_build_object(
    'planningDate', current_setting('test.b_date'), 'timezone', 'UTC',
    'asOf', current_setting('test.b_date') || 'T21:00',
    'tasks', jsonb_build_array(jsonb_build_object('ref', 't1', 'title', 'B task')),
    'totals', jsonb_build_object('total', 1));
  interp jsonb := jsonb_build_object('summary', 'B.', 'takeaway', 'B.', 'patterns', '[]'::jsonb, 'carryForward', '[]'::jsonb);
begin
  if (select count(*) from public.eod_reports) <> 0 then
    raise exception 'CASE 10 FAILED: B can see A''s reports';
  end if;
  perform eodtest.expect('CASE 10a: B cannot file a report under A''s day',
    eodtest.call(current_setting('test.a_day')::uuid, repeat('1', 64), 'v1', b_facts, interp), 'P0002');
  perform eodtest.expect('CASE 10b: B can file their own', eodtest.call(current_setting('test.b_day')::uuid, repeat('1', 64), 'v1', b_facts, interp), 'ok');
  if (select count(*) from public.eod_reports) <> 1
     or (select count(*) from public.eod_reports where user_id <> '00000000-0000-0000-0000-0000000000e2') <> 0 then
    raise exception 'CASE 10 FAILED: B sees something other than their own single report';
  end if;
  raise notice 'CASE 10: cross-user isolation holds in both directions — OK';
end $$;

-- ── Case 11: unauthenticated callers ────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '', true);
do $$
begin
  perform eodtest.expect('CASE 11a: a session with no identity cannot create',
    eodtest.call(current_setting('test.a_day')::uuid, repeat('2', 64), 'v1', '{}', '{}'), '42501');
  if (select count(*) from public.eod_reports) <> 0 then
    raise exception 'CASE 11 FAILED: an unidentified session can read reports';
  end if;
  raise notice 'CASE 11b: ...and sees no rows — OK';
end $$;

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  perform eodtest.expect('CASE 12a: anon cannot read', 'select count(*) from public.eod_reports', '42501');
  perform eodtest.expect('CASE 12b: anon cannot execute the RPC',
    eodtest.call(current_setting('test.a_day')::uuid, repeat('3', 64), 'v1', '{}', '{}'), '42501');
end $$;

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
begin
  perform eodtest.expect('CASE 13a: service_role cannot read reports', 'select count(*) from public.eod_reports', '42501');
  perform eodtest.expect('CASE 13b: service_role cannot execute the RPC',
    eodtest.call(current_setting('test.a_day')::uuid, repeat('3', 64), 'v1', '{}', '{}'), '42501');
  perform eodtest.expect('CASE 13c: service_role cannot insert',
    'insert into public.eod_reports (user_id, day_id, state_fingerprint, prompt_version, facts, interpretation) select user_id, day_id, repeat(''4'', 64), ''v1'', facts, interpretation from public.eod_reports', '42501');
end $$;

-- ── Catalog facts and defense-in-depth (as superuser) ───────────────────────────────────────
reset role;
do $$
declare
  fn oid := 'public.create_eod_report(uuid, text, text, jsonb, jsonb)'::regprocedure;
begin
  if not (select prosecdef from pg_proc where oid = fn) then
    raise exception 'CASE 14 FAILED: create_eod_report is not SECURITY DEFINER';
  end if;
  if not exists (select 1 from pg_proc where oid = fn and proconfig @> array['search_path=""']) then
    raise exception 'CASE 14 FAILED: search_path is not pinned to the empty string';
  end if;
  if not has_function_privilege('authenticated', fn, 'execute')
     or has_function_privilege('anon', fn, 'execute')
     or has_function_privilege('service_role', fn, 'execute') then
    raise exception 'CASE 14 FAILED: EXECUTE must be granted to authenticated only';
  end if;
  if not has_table_privilege('authenticated', 'public.eod_reports', 'select')
     or has_table_privilege('authenticated', 'public.eod_reports', 'insert')
     or has_table_privilege('authenticated', 'public.eod_reports', 'update')
     or has_table_privilege('authenticated', 'public.eod_reports', 'delete')
     or has_table_privilege('anon', 'public.eod_reports', 'select')
     or has_table_privilege('service_role', 'public.eod_reports', 'select')
     or has_table_privilege('service_role', 'public.eod_reports', 'insert') then
    raise exception 'CASE 14 FAILED: table grants are wrong';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.eod_reports'::regclass) then
    raise exception 'CASE 14 FAILED: RLS is not enabled';
  end if;
  raise notice 'CASE 14: SECURITY DEFINER + search_path + EXECUTE/table grants + RLS are all as designed — OK';
end $$;

-- The table's own CHECK constraints stand on their own, even for a superuser inserting directly.
do $$
begin
  perform eodtest.expect('CASE 15a: CHECK rejects a malformed fingerprint',
    format('insert into public.eod_reports (user_id, day_id, state_fingerprint, prompt_version, facts, interpretation) values (%L, %L, %L, %L, %L, %L)',
      '00000000-0000-0000-0000-0000000000e1', current_setting('test.a_day'), 'nope', 'v1', '{}', '{}'), '23514');
  perform eodtest.expect('CASE 15b: CHECK rejects non-object facts',
    format('insert into public.eod_reports (user_id, day_id, state_fingerprint, prompt_version, facts, interpretation) values (%L, %L, %L, %L, %L, %L)',
      '00000000-0000-0000-0000-0000000000e1', current_setting('test.a_day'), repeat('7', 64), 'v1', '[]', '{}'), '23514');
  perform eodtest.expect('CASE 15c: UNIQUE (day, fingerprint) holds for a direct duplicate',
    format('insert into public.eod_reports (user_id, day_id, state_fingerprint, prompt_version, facts, interpretation) values (%L, %L, %L, %L, %L, %L)',
      '00000000-0000-0000-0000-0000000000e1', current_setting('test.a_day'), repeat('a', 64), 'v1', '{}', '{}'), '23505');
end $$;

do $$ begin raise notice 'EOD REPORTS ISOLATION OK'; end $$;

rollback;
