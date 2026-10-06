-- ─────────────────────────────────────────────────────────────────────────
-- Plan-from-briefing integrity / isolation check for Phase 8 (new tasks through
-- create_ai_proposal → confirm_ai_proposal_by_id, via ai_apply_changes_internal).
--
-- Same technique as the other files in this directory: throwaway auth.users rows, impersonated via
-- the `request.jwt.claims` GUC, everything inside ONE transaction, rolled back at the end. Run it
-- against a real Postgres whose roles mirror Supabase's, with every migration applied:
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/briefing_plan_isolation.sql
--
-- Covers: atomic creation (source 'planner', `created` history, exactly one 'ai' revision),
-- every rule the SQL re-derives for a create (shape, title, duration, window, priority, kind,
-- duplicates, overlaps), all-or-nothing rollback, replay, stale revision, foreign proposal /
-- briefing / day, creation only for a briefing-linked proposal, the direct `confirm_ai_proposal`
-- primitive still refusing creations, regression of the Phase 5.3 move/unschedule behaviour the
-- refactor moved into the internal function, privileges (anon / service_role / authenticated /
-- the unreachable internal function), no direct writes, and that confirmation itself writes NO
-- notification — the Phase 6 reconciler is what later discovers the new tasks. Two real
-- connections racing are exercised by supabase/tests/concurrent_briefing_confirm.sh.
--
-- Timing: the hour is truncated in UTC (a session zone with a half-hour offset would otherwise
-- not land on a whole local hour). The fixture user's timezone is chosen (an `Etc/GMT±N` zone) so that local time is
-- 12:xx right now, which puts every fixture window comfortably inside the local day whatever
-- the real clock says. `now()` is constant within the transaction.
-- ─────────────────────────────────────────────────────────────────────────

begin;

insert into auth.users (id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('00000000-0000-0000-0000-0000000008a1', 'authenticated', 'authenticated', 'p8-a@example.test', '', now(), now()),
  ('00000000-0000-0000-0000-0000000008b2', 'authenticated', 'authenticated', 'p8-b@example.test', '', now(), now());

-- ── helpers (throwaway schema; SECURITY INVOKER so the tested role's privileges apply) ──────────
create schema p8test;
grant usage on schema p8test to public;

create function p8test.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

create function p8test.expect(p_label text, p_sql text, p_state text) returns void
language plpgsql as $$
declare got text := p8test.try(p_sql);
begin
  if got is distinct from p_state then
    raise exception '% FAILED: expected %, got %', p_label, p_state, got;
  end if;
  raise notice '% — OK', p_label;
end;
$$;

-- The top of the fixture user's local hour: local midnight is exactly h() + 12h, and now() is
-- within the hour after h().
create function p8test.h() returns timestamptz language sql stable as $$
  select current_setting('test.h')::timestamptz
$$;

-- One `create` change. `p_start` is an instant; the duration is in minutes.
create function p8test.c(p_ref text, p_title text, p_start timestamptz, p_dur int,
                         p_prio text, p_kind text) returns jsonb language sql as $$
  select jsonb_build_object('ref', p_ref, 'type', 'create', 'title', p_title,
    'start', p_start, 'duration_minutes', p_dur, 'priority', p_prio, 'kind', p_kind)
$$;

create function p8test.mkprop(p_day uuid, p_rev int, p_changes jsonb, p_brief uuid,
                              p_status text default 'valid') returns uuid language sql as $$
  select (public.create_ai_proposal(p_day, p_rev, 'typed', 'Plan my day', 'ok', '[]'::jsonb,
            p_changes, '[]'::jsonb, '[]'::jsonb, p_status, p_brief)).id
$$;

create function p8test.conf(p_id uuid) returns text language sql as $$
  select format('select public.confirm_ai_proposal_by_id(%L)', p_id)
$$;

create function p8test.rev(p_day uuid) returns int language sql as $$
  select coalesce(max(r.revision_number), 0)::int
    from public.plan_revisions r join public.plans p on p.id = r.plan_id where p.day_id = p_day
$$;

-- Everything a failed confirmation must leave exactly as it found it.
create function p8test.snap(p_day uuid) returns text language sql as $$
  select (select count(*) from public.tasks where day_id = p_day)::text || '/' ||
         (select count(*) from public.plan_revisions r join public.plans p on p.id = r.plan_id
           where p.day_id = p_day)::text || '/' ||
         (select count(*) from public.task_history h join public.tasks t on t.id = h.task_id
           where t.day_id = p_day)::text || '/' ||
         (select coalesce(sum(extract(epoch from scheduled_start)::bigint + (case when unscheduled then 7 else 0 end)
                              + (case when schedule_locked then 13 else 0 end)), 0)
            from public.tasks where day_id = p_day)::text
$$;

-- Creates a stored proposal from `p_changes`, expects its confirmation to fail with `p_state`,
-- and asserts that NOTHING changed and the proposal is still pending (so it can be retried).
create function p8test.bad(p_label text, p_day uuid, p_rev int, p_changes jsonb, p_brief uuid,
                           p_state text) returns void language plpgsql as $$
declare
  before text := p8test.snap(p_day);
  pid uuid := p8test.mkprop(p_day, p_rev, p_changes, p_brief);
begin
  perform p8test.expect(p_label, p8test.conf(pid), p_state);
  if p8test.snap(p_day) <> before then
    raise exception '% FAILED: a refused confirmation changed the database', p_label;
  end if;
  if (select status from public.ai_proposals where id = pid) <> 'generated' then
    raise exception '% FAILED: the proposal was not left pending', p_label;
  end if;
end;
$$;
grant execute on all functions in schema p8test to public;

-- ── fixtures ────────────────────────────────────────────────────────────────────────────────
select 'Etc/GMT' || case when n = 0 then '' when n > 0 then '+' || n else '-' || abs(n) end as tz,
       (date_trunc('hour', now() at time zone 'UTC') at time zone 'UTC') as h
  from (select extract(hour from now() at time zone 'UTC')::int - 12 as n) s \gset
select set_config('test.h', :'h', true) \gset

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000008a1', 'role', 'authenticated')::text, true);
insert into public.profiles (id, timezone) values ('00000000-0000-0000-0000-0000000008a1', :'tz');
select * from public.ensure_day() \gset a_day_
select * from public.ensure_day((:'a_day_local_date'::date + 2)) \gset a_fut_

insert into public.briefings (user_id, day_id, raw_text)
values ('00000000-0000-0000-0000-0000000008a1', :'a_day_id', 'Finish report, gym, groceries by 6pm') returning id as a_brief \gset
insert into public.briefings (user_id, day_id, raw_text)
values ('00000000-0000-0000-0000-0000000008a1', :'a_fut_id', 'A future briefing') returning id as a_fut_brief \gset

-- A's existing tasks, through the real RPC (never a raw insert). The helper's `now()` is fixed,
-- so these windows are stable for the whole script.
select id as t_run from public.create_task_with_history(:'a_day_id', 'Running', null, 'medium', 'flexible',
  now() - interval '10 minutes', now() + interval '20 minutes', null, 'user') \gset
select id as t_gym from public.create_task_with_history(:'a_day_id', 'Gym', null, 'medium', 'flexible',
  :'h'::timestamptz + interval '3 hours', :'h'::timestamptz + interval '4 hours', null, 'user') \gset
select id as t_stand from public.create_task_with_history(:'a_day_id', 'Standup', null, 'high', 'fixed',
  :'h'::timestamptz + interval '5 hours', :'h'::timestamptz + interval '5 hours 30 minutes', null, 'user') \gset
select id as t_lock from public.create_task_with_history(:'a_day_id', 'Locked block', null, 'low', 'flexible',
  :'h'::timestamptz + interval '7 hours', :'h'::timestamptz + interval '8 hours', null, 'user') \gset
-- Pin it by hand-moving it (reschedule_task locks the schedule); the window itself is unchanged.
select * from public.reschedule_task(:'t_lock', :'h'::timestamptz + interval '7 hours',
  :'h'::timestamptz + interval '8 hours') \gset lock_

select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000008b2', 'role', 'authenticated')::text, true);
insert into public.profiles (id, timezone) values ('00000000-0000-0000-0000-0000000008b2', :'tz');
select * from public.ensure_day() \gset b_day_
insert into public.briefings (user_id, day_id, raw_text)
values ('00000000-0000-0000-0000-0000000008b2', :'b_day_id', 'B''s private briefing') returning id as b_brief \gset

select set_config('test.a_day', :'a_day_id', true), set_config('test.a_fut', :'a_fut_id', true),
       set_config('test.b_day', :'b_day_id', true), set_config('test.a_brief', :'a_brief', true),
       set_config('test.a_fut_brief', :'a_fut_brief', true), set_config('test.b_brief', :'b_brief', true),
       set_config('test.t_run', :'t_run', true), set_config('test.t_gym', :'t_gym', true),
       set_config('test.t_stand', :'t_stand', true), set_config('test.t_lock', :'t_lock', true) \gset

-- ── as A ────────────────────────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000008a1', 'role', 'authenticated')::text, true);

-- Cases 1–2: a briefing proposal creates tasks and moves one, atomically; replay is refused.
do $$
declare
  d uuid := current_setting('test.a_day')::uuid;
  h timestamptz := p8test.h();
  gym uuid := current_setting('test.t_gym')::uuid;
  pid uuid; new_rev int; n int; r record; before text;
  changes jsonb;
begin
  if p8test.rev(d) <> 1 then raise exception 'fixture: expected revision 1, got %', p8test.rev(d); end if;
  changes := jsonb_build_array(
    p8test.c('n1', 'Deep work', h + interval '1 hour 30 minutes', 60, 'medium', 'flexible'),
    p8test.c('n2', '  Email   catch-up ', h + interval '4 hours', 30, 'low', 'optional'),
    p8test.c('n3', 'Groceries', h + interval '9 hours', 45, 'high', 'deadline'),
    jsonb_build_object('ref', 't1', 'task_id', gym, 'type', 'move', 'new_start', h + interval '10 hours'));
  pid := p8test.mkprop(d, 1, changes, current_setting('test.a_brief')::uuid);

  select count(*) into n from public.scheduled_notifications
   where user_id = '00000000-0000-0000-0000-0000000008a1';
  select public.confirm_ai_proposal_by_id(pid) into new_rev;
  if new_rev <> 2 then raise exception 'CASE 1 FAILED: expected revision 2, got %', new_rev; end if;

  -- Three NEW planner tasks, exactly as proposed (end derived, title normalized, no extras).
  select count(*) into n from public.tasks where day_id = d and source = 'planner';
  if n <> 3 then raise exception 'CASE 1 FAILED: expected 3 planner tasks, got %', n; end if;
  for r in select * from public.tasks where day_id = d and source = 'planner' order by scheduled_start loop
    if r.user_id <> '00000000-0000-0000-0000-0000000008a1' or r.status <> 'upcoming'
       or r.schedule_locked or r.unscheduled or r.notes is not null or r.due_at is not null
       or r.completed_at is not null then
      raise exception 'CASE 1 FAILED: created task has unexpected fields (%)', r.title;
    end if;
  end loop;
  if not exists (select 1 from public.tasks where day_id = d and title = 'Deep work' and kind = 'flexible'
       and priority = 'medium' and scheduled_start = h + interval '1 hour 30 minutes'
       and scheduled_end = h + interval '2 hours 30 minutes')
     or not exists (select 1 from public.tasks where day_id = d and title = 'Email catch-up' and kind = 'optional'
       and priority = 'low' and scheduled_end - scheduled_start = interval '30 minutes')
     or not exists (select 1 from public.tasks where day_id = d and title = 'Groceries' and kind = 'deadline'
       and priority = 'high' and scheduled_end - scheduled_start = interval '45 minutes') then
    raise exception 'CASE 1 FAILED: created tasks do not match the proposal';
  end if;
  raise notice 'CASE 1a: three new tasks created as source planner, derived ends, normalized title — OK';

  -- History: one `created` row per new task, source ai, linked to the new revision; the move
  -- is a `rescheduled` row. No row for anything else.
  select count(*) into n from public.task_history h2 join public.tasks t on t.id = h2.task_id
   where t.day_id = d and t.source = 'planner' and h2.event = 'created' and h2.source = 'ai'
     and h2.previous_status is null and h2.new_status = 'upcoming'
     and h2.revision_id = (select r2.id from public.plan_revisions r2 join public.plans p on p.id = r2.plan_id
                            where p.day_id = d and r2.revision_number = 2);
  if n <> 3 then raise exception 'CASE 1 FAILED: expected 3 created/ai history rows linked to revision 2, got %', n; end if;
  if (select count(*) from public.task_history where task_id = gym and event = 'rescheduled' and source = 'ai') <> 1 then
    raise exception 'CASE 1 FAILED: the move has no rescheduled/ai history row';
  end if;
  raise notice 'CASE 1b: created history (source ai, linked to the revision) and the move''s history — OK';

  -- Exactly ONE new revision, source ai; the move applied and locked.
  select count(*) into n from public.plan_revisions rv join public.plans p on p.id = rv.plan_id where p.day_id = d;
  if n <> 2 or (select rv.source from public.plan_revisions rv join public.plans p on p.id = rv.plan_id
                 where p.day_id = d and rv.revision_number = 2) <> 'ai' then
    raise exception 'CASE 1 FAILED: expected exactly one new ai revision';
  end if;
  if not exists (select 1 from public.tasks where id = gym and scheduled_start = h + interval '10 hours' and schedule_locked) then
    raise exception 'CASE 1 FAILED: the move did not apply';
  end if;
  if not exists (select 1 from public.ai_proposals where id = pid and status = 'confirmed' and applied_revision_number = 2 and confirmed_at is not null) then
    raise exception 'CASE 1 FAILED: proposal not marked confirmed';
  end if;
  raise notice 'CASE 1c: exactly one ai revision; move applied and locked; proposal confirmed — OK';

  -- Confirmation itself writes no notification (the Phase 6 reconciler discovers the tasks later).
  select count(*) into n from public.scheduled_notifications
   where user_id = '00000000-0000-0000-0000-0000000008a1';
  if n <> 0 then raise exception 'CASE 1 FAILED: confirmation wrote % notification row(s)', n; end if;
  raise notice 'CASE 1d: confirmation wrote no notifications — OK';

  -- 2. Replay: a second confirmation of the same proposal is refused; nothing doubles.
  before := p8test.snap(d);
  perform p8test.expect('CASE 2: replaying a confirmed proposal is refused (P0002)', p8test.conf(pid), 'P0002');
  if p8test.snap(d) <> before then raise exception 'CASE 2 FAILED: replay changed the database'; end if;
end $$;

-- Case 3: a stale proposal (base revision no longer current) is refused; nothing is created.
do $$
declare
  d uuid := current_setting('test.a_day')::uuid;
  h timestamptz := p8test.h();
  before text := p8test.snap(d);
  pid uuid;
begin
  pid := p8test.mkprop(d, 1, jsonb_build_array(p8test.c('n1', 'Walk', h + interval '8 hours', 30, 'low', 'optional')),
                       current_setting('test.a_brief')::uuid);
  perform p8test.expect('CASE 3: stale base revision is refused (40001)', p8test.conf(pid), '40001');
  if p8test.snap(d) <> before then raise exception 'CASE 3 FAILED: a stale confirmation changed the database'; end if;
  if (select status from public.ai_proposals where id = pid) <> 'generated' then
    raise exception 'CASE 3 FAILED: stale proposal was consumed';
  end if;
end $$;

-- Case 4: another user cannot confirm A's proposal, or use A's day / briefing.
do $$
declare
  d uuid := current_setting('test.a_day')::uuid;
  h timestamptz := p8test.h();
  pid uuid := (select id from public.ai_proposals where day_id = d and status = 'generated');
begin
  if pid is null then raise exception 'fixture: expected a pending proposal'; end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', '00000000-0000-0000-0000-0000000008b2', 'role', 'authenticated')::text, true);
  perform p8test.expect('CASE 4a: B cannot confirm A''s proposal (P0002)', p8test.conf(pid), 'P0002');
  perform p8test.expect('CASE 4b: B cannot create a proposal on A''s day (P0002)',
    format($f$select p8test.mkprop(%L, 2, '[]'::jsonb, null)$f$, d), 'P0002');
  perform p8test.expect('CASE 4c: B cannot link A''s briefing to its own day (P0002)',
    format($f$select p8test.mkprop(%L, 1, '[]'::jsonb, %L)$f$, current_setting('test.b_day'), current_setting('test.a_brief')), 'P0002');
  perform p8test.expect('CASE 4d: B cannot apply creations to A''s day directly (P0002)',
    format($f$select public.confirm_ai_proposal(%L, 2, %L::jsonb)$f$, d,
           jsonb_build_array(p8test.c('n1', 'Intruder', h + interval '8 hours', 30, 'low', 'optional'))), 'P0002');
  if (select count(*) from public.ai_proposals) <> 0 or (select count(*) from public.tasks) <> 0 then
    raise exception 'CASE 4 FAILED: B can see A''s rows';
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', '00000000-0000-0000-0000-0000000008a1', 'role', 'authenticated')::text, true);
end $$;

-- Case 5: the lower-level confirm_ai_proposal() primitive can still not create anything.
do $$
declare
  d uuid := current_setting('test.a_day')::uuid;
  h timestamptz := p8test.h();
  before text := p8test.snap(d);
begin
  perform p8test.expect('CASE 5: confirm_ai_proposal() refuses a create (22023)',
    format($f$select public.confirm_ai_proposal(%L, 2, %L::jsonb)$f$, d,
           jsonb_build_array(p8test.c('n1', 'Sneaky', h + interval '8 hours', 30, 'low', 'optional'))), '22023');
  if p8test.snap(d) <> before then raise exception 'CASE 5 FAILED: the refused call changed the database'; end if;
end $$;

-- Case 6: all-or-nothing. One bad element anywhere rolls back EVERY creation and move.
do $$
declare
  d uuid := current_setting('test.a_day')::uuid;
  b uuid := current_setting('test.a_brief')::uuid;
  h timestamptz := p8test.h();
  ok jsonb := p8test.c('n1', 'First ok', h + interval '8 hours 30 minutes', 30, 'medium', 'flexible');
begin
  perform p8test.bad('CASE 6a: second create overlaps an existing task → 23P01, first not created', d, 2,
    jsonb_build_array(ok, p8test.c('n2', 'Collides with standup', h + interval '5 hours 10 minutes', 30, 'medium', 'flexible')),
    b, '23P01');
  perform p8test.bad('CASE 6b: second create reuses an existing title (case/space-insensitive) → 22023', d, 2,
    jsonb_build_array(ok, p8test.c('n2', '  GYM  ', h + interval '11 hours', 30, 'medium', 'flexible')), b, '22023');
  perform p8test.bad('CASE 6c: a move of an ineligible (fixed) task alongside a create → P0002', d, 2,
    jsonb_build_array(ok, jsonb_build_object('ref', 't9', 'task_id', current_setting('test.t_stand'),
      'type', 'move', 'new_start', h + interval '6 hours')), b, 'P0002');
  perform p8test.bad('CASE 6d: second create already over → 22023', d, 2,
    jsonb_build_array(ok, p8test.c('n2', 'Over already', h - interval '3 hours', 30, 'medium', 'flexible')), b, '22023');
  perform p8test.bad('CASE 6e: two creates share a title (case-insensitive) → 22023', d, 2,
    jsonb_build_array(ok, p8test.c('n2', 'FIRST OK', h + interval '11 hours', 30, 'medium', 'flexible')), b, '22023');
  perform p8test.bad('CASE 6f: two creates overlap each other → 23P01', d, 2,
    jsonb_build_array(ok, p8test.c('n2', 'Overlaps first', h + interval '8 hours 45 minutes', 30, 'medium', 'flexible')),
    b, '23P01');
  perform p8test.bad('CASE 6g: a create overlapping the task that is running now → 23P01', d, 2,
    jsonb_build_array(p8test.c('n1', 'During the run', now() + interval '5 minutes', 30, 'medium', 'flexible')), b, '23P01');
end $$;

-- Case 7: every rule the SQL re-derives for a create. Each is refused whole, changing nothing.
do $$
declare
  d uuid := current_setting('test.a_day')::uuid;
  b uuid := current_setting('test.a_brief')::uuid;
  h timestamptz := p8test.h();
  v jsonb := p8test.c('n1', 'Valid title', h + interval '8 hours 30 minutes', 30, 'medium', 'flexible');
begin
  -- shape: nothing but the seven keys may appear, and nothing an attacker could use to steer
  perform p8test.bad('CASE 7a: an `end` key', d, 2, jsonb_build_array(v || jsonb_build_object('end', h + interval '9 hours')), b, '22023');
  perform p8test.bad('CASE 7b: a `source` key', d, 2, jsonb_build_array(v || '{"source":"user"}'), b, '22023');
  perform p8test.bad('CASE 7c: a `notes` key', d, 2, jsonb_build_array(v || '{"notes":"x"}'), b, '22023');
  perform p8test.bad('CASE 7d: a `task_id` key', d, 2, jsonb_build_array(v || jsonb_build_object('task_id', gen_random_uuid())), b, '22023');
  perform p8test.bad('CASE 7e: a `status` key', d, 2, jsonb_build_array(v || '{"status":"completed"}'), b, '22023');
  perform p8test.bad('CASE 7f: a `user_id` key', d, 2, jsonb_build_array(v || jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000008b2')), b, '22023');
  perform p8test.bad('CASE 7g: a `due_at` key', d, 2, jsonb_build_array(v || '{"due_at":"2030-01-01T00:00:00Z"}'), b, '22023');
  perform p8test.bad('CASE 7h: a `schedule_locked` key', d, 2, jsonb_build_array(v || '{"schedule_locked":true}'), b, '22023');
  -- ref
  perform p8test.bad('CASE 7i: a t-style ref on a create', d, 2, jsonb_build_array(jsonb_set(v, '{ref}', '"t1"')), b, '22023');
  perform p8test.bad('CASE 7j: ref n0', d, 2, jsonb_build_array(jsonb_set(v, '{ref}', '"n0"')), b, '22023');
  perform p8test.bad('CASE 7k: no ref', d, 2, jsonb_build_array(v - 'ref'), b, '22023');
  -- title
  perform p8test.bad('CASE 7l: blank title', d, 2, jsonb_build_array(jsonb_set(v, '{title}', '"   "')), b, '22023');
  perform p8test.bad('CASE 7m: 101-character title', d, 2, jsonb_build_array(jsonb_set(v, '{title}', to_jsonb(repeat('x', 101)))), b, '22023');
  perform p8test.bad('CASE 7n: line break in title', d, 2, jsonb_build_array(jsonb_set(v, '{title}', to_jsonb(E'a\nb'::text))), b, '22023');
  perform p8test.bad('CASE 7o: zero-width character in title', d, 2, jsonb_build_array(jsonb_set(v, '{title}', to_jsonb('a' || chr(8203) || 'b'))), b, '22023');
  perform p8test.bad('CASE 7p: markup in title', d, 2, jsonb_build_array(jsonb_set(v, '{title}', '"<b>bold</b>"')), b, '22023');
  perform p8test.bad('CASE 7q: link in title', d, 2, jsonb_build_array(jsonb_set(v, '{title}', '"see https://evil.example"')), b, '22023');
  perform p8test.bad('CASE 7r: markdown link in title', d, 2, jsonb_build_array(jsonb_set(v, '{title}', '"[x](y)"')), b, '22023');
  perform p8test.bad('CASE 7s0: no title', d, 2, jsonb_build_array(v - 'title'), b, '22023');
  perform p8test.bad('CASE 7s: non-string title', d, 2, jsonb_build_array(jsonb_set(v, '{title}', '42')), b, '22023');
  -- duration
  perform p8test.bad('CASE 7t: 4 minutes', d, 2, jsonb_build_array(jsonb_set(v, '{duration_minutes}', '4')), b, '22023');
  perform p8test.bad('CASE 7u: 1441 minutes', d, 2, jsonb_build_array(jsonb_set(v, '{duration_minutes}', '1441')), b, '22023');
  perform p8test.bad('CASE 7v: fractional minutes', d, 2, jsonb_build_array(jsonb_set(v, '{duration_minutes}', '30.5')), b, '22023');
  perform p8test.bad('CASE 7w: duration as a string', d, 2, jsonb_build_array(jsonb_set(v, '{duration_minutes}', '"30"')), b, '22023');
  perform p8test.bad('CASE 7x: no duration', d, 2, jsonb_build_array(v - 'duration_minutes'), b, '22023');
  -- priority / kind
  perform p8test.bad('CASE 7y: priority urgent', d, 2, jsonb_build_array(jsonb_set(v, '{priority}', '"urgent"')), b, '22023');
  perform p8test.bad('CASE 7z: kind recurring', d, 2, jsonb_build_array(jsonb_set(v, '{kind}', '"recurring"')), b, '22023');
  perform p8test.bad('CASE 7aa: no kind', d, 2, jsonb_build_array(v - 'kind'), b, '22023');
  -- time
  perform p8test.bad('CASE 7ab: unparseable start', d, 2, jsonb_build_array(jsonb_set(v, '{start}', '"soon"')), b, '22023');
  perform p8test.bad('CASE 7ac: no start', d, 2, jsonb_build_array(v - 'start'), b, '22023');
  perform p8test.bad('CASE 7ad: starts before the day', d, 2, jsonb_build_array(jsonb_set(v, '{start}', to_jsonb(h - interval '13 hours'))), b, '22023');
  perform p8test.bad('CASE 7ae: ends after the day (starts inside)', d, 2,
    jsonb_build_array(jsonb_set(jsonb_set(v, '{start}', to_jsonb(h + interval '11 hours 30 minutes')), '{duration_minutes}', '60')), b, '22023');
  perform p8test.bad('CASE 7af: starts on the next day', d, 2, jsonb_build_array(jsonb_set(v, '{start}', to_jsonb(h + interval '13 hours'))), b, '22023');
  perform p8test.bad('CASE 7ag: wholly in the past', d, 2, jsonb_build_array(jsonb_set(v, '{start}', to_jsonb(h - interval '5 hours'))), b, '22023');
  -- envelope
  perform p8test.bad('CASE 7ah: an unknown change type', d, 2, jsonb_build_array(jsonb_set(v, '{type}', '"delete"')), b, '22023');
  perform p8test.bad('CASE 7ai: a non-object element', d, 2, jsonb_build_array('"x"'::jsonb), b, '22023');
  perform p8test.expect('CASE 7aj: an empty change list cannot be confirmed (22023)',
    p8test.conf(p8test.mkprop(d, 2, '[]'::jsonb, b)), '22023');
  perform p8test.expect('CASE 7ak: a proposal that is not `valid` cannot be confirmed (P0002)',
    p8test.conf(p8test.mkprop(d, 2, jsonb_build_array(v), b, 'partially_valid')), 'P0002');
end $$;

-- Case 8: create_ai_proposal rules around creation and briefing ownership.
do $$
declare
  d uuid := current_setting('test.a_day')::uuid;
  h timestamptz := p8test.h();
  v jsonb := p8test.c('n1', 'Valid title', h + interval '8 hours 30 minutes', 30, 'medium', 'flexible');
  n int;
begin
  perform p8test.expect('CASE 8a: creations without a briefing are refused at storage (22023)',
    format($f$select p8test.mkprop(%L, 2, %L::jsonb, null)$f$, d, jsonb_build_array(v)), '22023');
  perform p8test.expect('CASE 8b: another user''s briefing cannot be linked (P0002)',
    format($f$select p8test.mkprop(%L, 2, %L::jsonb, %L)$f$, d, jsonb_build_array(v), current_setting('test.b_brief')), 'P0002');
  perform p8test.expect('CASE 8c: a briefing saved for a different day cannot be linked (P0002)',
    format($f$select p8test.mkprop(%L, 2, %L::jsonb, %L)$f$, d, jsonb_build_array(v), current_setting('test.a_fut_brief')), 'P0002');
  perform p8test.expect('CASE 8d: more than 20 changes is refused (22023)',
    format($f$select p8test.mkprop(%L, 2, %L::jsonb, %L)$f$, d,
      (select jsonb_agg(v) from generate_series(1, 21)), current_setting('test.a_brief')), '22023');
  perform p8test.expect('CASE 8e: the ordinary 10-argument call (no briefing) still works',
    format($f$select public.create_ai_proposal(%L, 2, 'typed', 't', 'u', '[]', '[]', '[]', '[]', 'invalid')$f$, d), 'ok');
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = 'create_ai_proposal';
  if n <> 1 then raise exception 'CASE 8f FAILED: % overloads of create_ai_proposal (expected 1)', n; end if;
  raise notice 'CASE 8f: exactly one create_ai_proposal overload — OK';
  -- A proposal is stored with its briefing link.
  perform p8test.mkprop(d, 2, '[]'::jsonb, current_setting('test.a_brief')::uuid, 'invalid');
  if not exists (select 1 from public.ai_proposals where day_id = d and status = 'generated'
                   and briefing_id = current_setting('test.a_brief')::uuid) then
    raise exception 'CASE 8g FAILED: the briefing link was not stored';
  end if;
  raise notice 'CASE 8g: the proposal stores the briefing it was planned from — OK';
end $$;

-- Case 9: regression — the Phase 5.3 move / unschedule behaviour, now inside the internal function.
select id as t_rega from public.create_task_with_history(:'a_day_id', 'Reg A', null, 'medium', 'flexible',
  :'h'::timestamptz + interval '2 hours 45 minutes', :'h'::timestamptz + interval '3 hours 15 minutes', null, 'user') \gset
select id as t_regb from public.create_task_with_history(:'a_day_id', 'Reg B', null, 'medium', 'flexible',
  :'h'::timestamptz + interval '11 hours', :'h'::timestamptz + interval '11 hours 30 minutes', null, 'user') \gset
select set_config('test.t_rega', :'t_rega', true), set_config('test.t_regb', :'t_regb', true) \gset

do $$
declare
  d uuid := current_setting('test.a_day')::uuid;
  h timestamptz := p8test.h();
  rega uuid := current_setting('test.t_rega')::uuid;
  regb uuid := current_setting('test.t_regb')::uuid;
  mv   jsonb;
  before text;
  rev int;
begin
  -- The fixture's own create_task_with_history calls did not bump the revision.
  rev := p8test.rev(d);
  if rev <> 2 then raise exception 'fixture: expected revision 2, got %', rev; end if;

  before := p8test.snap(d);
  perform p8test.expect('CASE 9a: stale base (1 ≠ 2) via the direct primitive (40001)',
    format($f$select public.confirm_ai_proposal(%L, 1, %L::jsonb)$f$, d,
      jsonb_build_array(jsonb_build_object('ref','t1','task_id',rega,'type','move','new_start',h + interval '2 hours 30 minutes'))), '40001');
  perform p8test.expect('CASE 9b: a locked task is not eligible (P0002)',
    format($f$select public.confirm_ai_proposal(%L, 2, %L::jsonb)$f$, d,
      jsonb_build_array(jsonb_build_object('ref','t1','task_id',current_setting('test.t_lock'),'type','unschedule'))), 'P0002');
  perform p8test.expect('CASE 9c: a fixed task is not eligible (P0002)',
    format($f$select public.confirm_ai_proposal(%L, 2, %L::jsonb)$f$, d,
      jsonb_build_array(jsonb_build_object('ref','t1','task_id',current_setting('test.t_stand'),'type','unschedule'))), 'P0002');
  perform p8test.expect('CASE 9d: a task running now is not eligible (P0002)',
    format($f$select public.confirm_ai_proposal(%L, 2, %L::jsonb)$f$, d,
      jsonb_build_array(jsonb_build_object('ref','t1','task_id',current_setting('test.t_run'),'type','unschedule'))), 'P0002');
  perform p8test.expect('CASE 9e: the same task twice (22023)',
    format($f$select public.confirm_ai_proposal(%L, 2, %L::jsonb)$f$, d,
      jsonb_build_array(
        jsonb_build_object('ref','t1','task_id',rega,'type','unschedule'),
        jsonb_build_object('ref','t2','task_id',rega,'type','unschedule'))), '22023');
  perform p8test.expect('CASE 9f: a move with an `end` smuggled in (22023)',
    format($f$select public.confirm_ai_proposal(%L, 2, %L::jsonb)$f$, d,
      jsonb_build_array(jsonb_build_object('ref','t1','task_id',rega,'type','move',
        'new_start',h + interval '2 hours 30 minutes','new_end',h + interval '9 hours'))), '22023');
  perform p8test.expect('CASE 9g: a move onto the fixed Standup creates a conflict (23P01)',
    format($f$select public.confirm_ai_proposal(%L, 2, %L::jsonb)$f$, d,
      jsonb_build_array(jsonb_build_object('ref','t1','task_id',rega,'type','move','new_start',h + interval '5 hours 10 minutes'))), '23P01');
  perform p8test.expect('CASE 9h: a move wholly in the past (22023)',
    format($f$select public.confirm_ai_proposal(%L, 2, %L::jsonb)$f$, d,
      jsonb_build_array(jsonb_build_object('ref','t1','task_id',rega,'type','move','new_start',h - interval '5 hours'))), '22023');
  if p8test.snap(d) <> before then raise exception 'CASE 9 FAILED: a refused call changed the database'; end if;

  -- A good move + unschedule in one call: one revision, both locked / flagged, history written.
  perform public.confirm_ai_proposal(d, 2, jsonb_build_array(
    jsonb_build_object('ref','t1','task_id',rega,'type','move','new_start',h + interval '2 hours 45 minutes' + interval '15 minutes'),
    jsonb_build_object('ref','t2','task_id',regb,'type','unschedule')));
  if p8test.rev(d) <> 3 then raise exception 'CASE 9i FAILED: expected revision 3'; end if;
  if not exists (select 1 from public.tasks where id = rega and schedule_locked and scheduled_start = h + interval '3 hours')
     or not exists (select 1 from public.tasks where id = regb and unscheduled and schedule_locked) then
    raise exception 'CASE 9i FAILED: move/unschedule not applied';
  end if;
  if (select count(*) from public.task_history where task_id in (rega, regb) and event = 'rescheduled' and source = 'ai') <> 2 then
    raise exception 'CASE 9i FAILED: history missing';
  end if;
  raise notice 'CASE 9i: move + unschedule still apply atomically with one ai revision — OK';
end $$;

-- Case 10: the internal function is unreachable; the public ones have the right privileges.
do $$
declare
  sig text;
  d uuid := current_setting('test.a_day')::uuid;
begin
  foreach sig in array array['public.ai_apply_changes_internal(uuid,integer,jsonb,boolean)'] loop
    if has_function_privilege('authenticated', sig, 'execute') or has_function_privilege('anon', sig, 'execute')
       or has_function_privilege('service_role', sig, 'execute') or has_function_privilege('public', sig, 'execute') then
      raise exception 'CASE 10 FAILED: % is executable by a role', sig;
    end if;
  end loop;
  raise notice 'CASE 10a: ai_apply_changes_internal is executable by no role — OK';
  perform p8test.expect('CASE 10b: calling the internal function directly as authenticated is refused (42501)',
    format($f$select public.ai_apply_changes_internal(%L, 3, '[]'::jsonb, true)$f$, d), '42501');

  for sig in select unnest(array[
      'public.confirm_ai_proposal(uuid,integer,jsonb)', 'public.confirm_ai_proposal_by_id(uuid)',
      'public.create_ai_proposal(uuid,integer,text,text,text,jsonb,jsonb,jsonb,jsonb,text,uuid)',
      'public.discard_ai_proposal(uuid)']) loop
    if not has_function_privilege('authenticated', sig, 'execute') then raise exception 'CASE 10c FAILED: authenticated lost %', sig; end if;
    if has_function_privilege('anon', sig, 'execute') or has_function_privilege('service_role', sig, 'execute')
       or has_function_privilege('public', sig, 'execute') then
      raise exception 'CASE 10c FAILED: % is executable by anon/service_role/public', sig;
    end if;
  end loop;
  raise notice 'CASE 10c: the four user RPCs are authenticated-only — OK';

  for sig in select p.oid::regprocedure::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
              where s.nspname = 'public' and p.proname in
                ('ai_apply_changes_internal', 'confirm_ai_proposal', 'confirm_ai_proposal_by_id', 'create_ai_proposal') loop
    if not exists (select 1 from pg_proc p where p.oid = sig::regprocedure and p.prosecdef
                     and p.proconfig @> array['search_path=""']) then
      raise exception 'CASE 10d FAILED: % is not SECURITY DEFINER with search_path = ''''', sig;
    end if;
  end loop;
  raise notice 'CASE 10d: every function in the pipeline is SECURITY DEFINER with an empty search_path — OK';
end $$;

-- Case 11: no direct client writes exist, for tasks or proposals.
do $$
declare d uuid := current_setting('test.a_day')::uuid;
begin
  perform p8test.expect('CASE 11a: a direct INSERT into tasks is refused (42501)',
    format($f$insert into public.tasks (user_id, day_id, title, source, scheduled_start, scheduled_end)
              values ('00000000-0000-0000-0000-0000000008a1', %L, 'direct', 'planner', now(), now() + interval '1 hour')$f$, d), '42501');
  perform p8test.expect('CASE 11b: a direct INSERT into ai_proposals is refused (42501)',
    format($f$insert into public.ai_proposals (user_id, day_id, base_revision, source, transcript_text, understood, changes, validation_status)
              values ('00000000-0000-0000-0000-0000000008a1', %L, 3, 'typed', 'x', 'y', '[]', 'valid')$f$, d), '42501');
  perform p8test.expect('CASE 11c: a direct UPDATE of a proposal is refused (42501)',
    $f$update public.ai_proposals set status = 'confirmed'$f$, '42501');
end $$;

-- Case 12: anon and service_role cannot reach the pipeline (privilege layer), and no-identity is refused.
do $$
declare d uuid := current_setting('test.a_day')::uuid;
        pid uuid := (select id from public.ai_proposals where day_id = d and status = 'generated');
begin
  perform set_config('test.pid', coalesce(pid::text, ''), true);
end $$;

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select p8test.expect('CASE 12a: anon cannot confirm (42501)', p8test.conf(current_setting('test.pid')::uuid), '42501');
select p8test.expect('CASE 12b: anon cannot create a proposal (42501)',
  format($f$select public.create_ai_proposal(%L, 3, 'typed', 't', 'u', '[]', '[]', '[]', '[]', 'valid', null)$f$, :'a_day_id'), '42501');

set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
select p8test.expect('CASE 12c: service_role cannot confirm (42501)', p8test.conf(current_setting('test.pid')::uuid), '42501');
select p8test.expect('CASE 12d: service_role cannot create a proposal (42501)',
  format($f$select public.create_ai_proposal(%L, 3, 'typed', 't', 'u', '[]', '[]', '[]', '[]', 'valid', null)$f$, :'a_day_id'), '42501');
select p8test.expect('CASE 12e: service_role cannot apply changes directly (42501)',
  format($f$select public.confirm_ai_proposal(%L, 3, '[]')$f$, :'a_day_id'), '42501');
select p8test.expect('CASE 12f: service_role cannot read proposals (42501)',
  $f$select count(*) from public.ai_proposals$f$, '42501');

-- A signed-in role carrying no identity is refused by the function's own check as well.
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select p8test.expect('CASE 12g: authenticated with no sub cannot confirm (42501)', p8test.conf(current_setting('test.pid')::uuid), '42501');
select p8test.expect('CASE 12h: authenticated with no sub cannot create a proposal (42501)',
  format($f$select public.create_ai_proposal(%L, 3, 'typed', 't', 'u', '[]', '[]', '[]', '[]', 'valid', null)$f$, :'a_day_id'), '42501');

-- Case 13: the Phase 6 reconciler discovers the confirmed tasks — and only it writes notifications.
set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
do $$
declare
  d uuid := current_setting('test.a_day')::uuid;
  new_ids uuid[];
  n int; again int;
begin
  select array_agg(id) into new_ids from public.tasks where day_id = d and source = 'planner';
  if coalesce(array_length(new_ids, 1), 0) <> 3 then raise exception 'CASE 13 FAILED: expected 3 planner tasks'; end if;
  select count(*) into n from public.scheduled_notifications where task_id = any (new_ids);
  if n <> 0 then raise exception 'CASE 13 FAILED: reminders existed before the reconciler ran (%)', n; end if;

  perform * from public.reconcile_and_claim_notifications();
  select count(*) into n from public.scheduled_notifications
   where task_id = any (new_ids) and kind = 'task_reminder' and status in ('scheduled', 'claimed');
  if n <> 3 then raise exception 'CASE 13 FAILED: expected a reminder for each of the 3 new tasks, got %', n; end if;
  raise notice 'CASE 13a: reconciliation created one reminder for each new planner task — OK';

  perform * from public.reconcile_and_claim_notifications();
  perform * from public.reconcile_and_claim_notifications();
  select count(*) into again from public.scheduled_notifications where task_id = any (new_ids);
  if again <> 3 then raise exception 'CASE 13 FAILED: repeated reconciliation duplicated reminders (%)', again; end if;
  raise notice 'CASE 13b: repeated reconciliation is idempotent — OK';
end $$;

rollback;

select 'BRIEFING PLAN ISOLATION OK' as result;
