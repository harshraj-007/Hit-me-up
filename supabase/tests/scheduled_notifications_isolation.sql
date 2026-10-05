-- ─────────────────────────────────────────────────────────────────────────
-- Notification reconciliation + claim isolation check for Phase 6.2.
--
-- Same technique as rls_isolation.sql / push_subscriptions_isolation.sql: throwaway
-- auth.users rows, impersonated via the `request.jwt.claims` GUC, everything inside one
-- transaction, rolled back at the end. Run it against a real Postgres with every migration
-- applied:
--
--   supabase start
--   supabase db reset
--   psql "$(supabase status -o env | grep DB_URL | cut -d= -f2)" \
--        -f supabase/tests/scheduled_notifications_isolation.sql
--
-- This covers everything provable in a single session/transaction (identity, reconciliation
-- correctness, idempotency, RLS, grants, SECURITY DEFINER, the presence of the SKIP LOCKED
-- mechanism). Genuine concurrent-claim behavior (two sessions racing the same due row) is NOT
-- provable in one transaction — see the separate two-process script this repo's Phase 6.2
-- verification report describes running by hand.
--
-- Known limitation: fixture task windows are expressed as small `now() + interval` offsets
-- (minutes), which must stay inside the UTC planning day `ensure_day()` creates for "today".
-- If this script happens to run within roughly the last hour of the UTC day, a fixture could
-- in rare cases fail with "start must be inside the task's planning day" — a test-timing
-- artifact, not a Phase 6.2 defect. Re-running the script (a minute later, once the UTC date
-- has rolled over) resolves it.
-- ─────────────────────────────────────────────────────────────────────────

begin;

insert into auth.users (id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'user-a@example.test', '', now(), now()),
  ('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'authenticated', 'user-b@example.test', '', now(), now());

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);

insert into public.profiles (id, timezone) values ('00000000-0000-0000-0000-0000000000a1', 'UTC');
-- `select * from fn()` (not `select fn()`) expands the returned composite's own columns —
-- `\gset` then stores each one as a psql variable under the given prefix (id, user_id, ...).
select * from public.ensure_day() \gset a_day_

-- Fixture tasks, all owned by A, via the real task-creation RPC (never a raw insert). ("due
-- now" is deliberately NOT created here — its whole point is being freshly due, so it is
-- created immediately before the claim-specific cases below, not touched by any earlier
-- reconcile call in this script.)
select id as soon_task_id from public.create_task_with_history(
  :'a_day_id', 'due later', null, 'medium', 'flexible',
  now() + interval '15 minutes', now() + interval '45 minutes', null, 'user'
) \gset
-- A task 30h out needs its OWN planning day that far out (today's day only spans 24h); the
-- horizon check being tested is about the task's schedule, not which day owns it.
select * from public.ensure_day((current_date + 2)::date) \gset far_day_
select id as far_task_id from public.create_task_with_history(
  :'far_day_id', 'far future', null, 'medium', 'flexible',
  (:'far_day_local_date')::date + time '12:00', (:'far_day_local_date')::date + time '13:00',
  null, 'user'
) \gset
select id as reschedule_task_id from public.create_task_with_history(
  :'a_day_id', 'will be rescheduled', null, 'medium', 'flexible',
  now() + interval '20 minutes', now() + interval '50 minutes', null, 'user'
) \gset
select id as complete_task_id from public.create_task_with_history(
  :'a_day_id', 'will be completed', null, 'medium', 'flexible',
  now() + interval '20 minutes', now() + interval '50 minutes', null, 'user'
) \gset
select id as skip_upfront_task_id from public.create_task_with_history(
  :'a_day_id', 'will be skipped upfront', null, 'medium', 'flexible',
  now() + interval '20 minutes', now() + interval '50 minutes', null, 'user'
) \gset

-- The "invalid/non-actionable" fixture for case 9: skipped BEFORE reconciliation ever runs.
select public.change_task_status(:'skip_upfront_task_id', 'skipped');

-- The RPC itself is system-only; simulate the cron caller exactly like a real service-role
-- JWT would arrive: Postgres role AND the JWT's own role claim.
set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

-- ── Cases 1-2: an upcoming task creates a reminder, at exactly the right time ───────────────
select public.reconcile_and_claim_notifications();

do $$
declare
  v_row  public.scheduled_notifications;
  v_task public.tasks;
begin
  select * into v_task from public.tasks where title = 'due later';
  select * into v_row from public.scheduled_notifications where task_id = v_task.id;
  if v_row.id is null then
    raise exception 'CASE 1 FAILED: an upcoming, in-horizon task did not get a reminder';
  end if;
  if v_row.status <> 'scheduled' then
    raise exception 'CASE 1 FAILED: new reminder status is % (expected scheduled)', v_row.status;
  end if;
  if v_row.fire_at <> v_task.scheduled_start - interval '10 minutes' then
    raise exception 'CASE 2 FAILED: fire_at is not exactly scheduled_start - 10 minutes';
  end if;
  if v_row.task_scheduled_start_snapshot <> v_task.scheduled_start then
    raise exception 'CASE 1 FAILED: snapshot does not match the task''s scheduled_start';
  end if;
  if v_row.user_id <> v_task.user_id or v_row.day_id <> v_task.day_id then
    raise exception 'CASE 1 FAILED: notification does not share user/day with its task';
  end if;
end $$;
do $$ begin raise notice 'CASE 1+2: upcoming task creates a correctly-timed reminder — OK'; end $$;

-- ── Case 3: repeated reconciliation is idempotent — no duplicate, no spurious update ────────
do $$
declare v_before timestamptz; v_after timestamptz; v_count int;
begin
  select updated_at into v_before from public.scheduled_notifications
   where task_id = (select id from public.tasks where title = 'due later');
  perform public.reconcile_and_claim_notifications();
  select count(*) into v_count from public.scheduled_notifications
   where task_id = (select id from public.tasks where title = 'due later');
  select updated_at into v_after from public.scheduled_notifications
   where task_id = (select id from public.tasks where title = 'due later');
  if v_count <> 1 then
    raise exception 'CASE 4 FAILED: repeated reconciliation created a duplicate reminder (count=%)', v_count;
  end if;
  if v_before <> v_after then
    raise exception 'CASE 3 FAILED: an unchanged task''s reminder was rewritten (no-op should mean no write)';
  end if;
end $$;
do $$ begin raise notice 'CASE 3+4: repeated reconciliation is idempotent, no duplicate — OK'; end $$;

-- ── Case 10: a task outside the 24h horizon gets no reminder ────────────────────────────────
do $$
begin
  if exists (
    select 1 from public.scheduled_notifications
     where task_id = (select id from public.tasks where title = 'far future')
  ) then
    raise exception 'CASE 10 FAILED: a task 30 hours out was given a reminder';
  end if;
end $$;
do $$ begin raise notice 'CASE 10: a task outside the scheduling horizon gets no reminder — OK'; end $$;

-- ── Case 9: a task skipped before it was ever reconciled never gets a reminder ──────────────
do $$
begin
  if exists (
    select 1 from public.scheduled_notifications
     where task_id = (select id from public.tasks where title = 'will be skipped upfront')
  ) then
    raise exception 'CASE 9 FAILED: an already-skipped task was given a reminder';
  end if;
end $$;
do $$ begin raise notice 'CASE 9: a non-actionable task never receives a reminder — OK'; end $$;

-- ── Cases 5-6: rescheduling updates fire_at; the OLD time is never claimable again ──────────
do $$
declare v_old_fire_at timestamptz;
begin
  select fire_at into v_old_fire_at from public.scheduled_notifications
   where task_id = (select id from public.tasks where title = 'will be rescheduled');
  perform set_config('test.old_fire_at', v_old_fire_at::text, true);
end $$;

-- Reschedule as the OWNER, through the real, unmodified reschedule_task() RPC.
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);
-- A modest push (not hours) deliberately: it must stay inside the SAME UTC planning day
-- `ensure_day()` created for "today", and a multi-hour jump risks crossing UTC midnight when
-- this script happens to run late in the UTC day (a real edge case this file hit once while
-- being written). 15 minutes is enough to prove fire_at actually changed.
select public.reschedule_task(
  (select id from public.tasks where title = 'will be rescheduled'),
  now() + interval '35 minutes',
  now() + interval '1 hour 5 minutes'
);

set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
select public.reconcile_and_claim_notifications();

do $$
declare v_row public.scheduled_notifications; v_task public.tasks;
begin
  select * into v_task from public.tasks where title = 'will be rescheduled';
  select * into v_row from public.scheduled_notifications where task_id = v_task.id;
  if v_row.fire_at <> v_task.scheduled_start - interval '10 minutes' then
    raise exception 'CASE 5 FAILED: fire_at was not updated to the new scheduled_start - 10 minutes';
  end if;
  if v_row.fire_at = current_setting('test.old_fire_at')::timestamptz then
    raise exception 'CASE 6 FAILED: fire_at is unchanged — still the pre-reschedule time';
  end if;
  if v_row.status <> 'scheduled' then
    raise exception 'CASE 6 FAILED: reconciled row is not scheduled (status=%)', v_row.status;
  end if;
end $$;
do $$ begin raise notice 'CASE 5+6: rescheduling updates fire_at; the old time cannot remain claimable — OK'; end $$;

-- ── Cases 7-8: completed/skipped tasks cancel their (still-active) reminder ─────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);
select public.change_task_status((select id from public.tasks where title = 'will be completed'), 'completed');
select id as skip_after_task_id from public.create_task_with_history(
  :'a_day_id', 'will be skipped after scheduling', null, 'medium', 'flexible',
  now() + interval '20 minutes', now() + interval '50 minutes', null, 'user'
) \gset

set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
select public.reconcile_and_claim_notifications(); -- creates the reminder for skip_after_task_id too

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);
select public.change_task_status((select id from public.tasks where title = 'will be skipped after scheduling'), 'skipped');

set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
select public.reconcile_and_claim_notifications();

do $$
declare v_row public.scheduled_notifications;
begin
  select * into v_row from public.scheduled_notifications
   where task_id = (select id from public.tasks where title = 'will be completed');
  if v_row.status <> 'canceled' or v_row.resolved_at is null then
    raise exception 'CASE 7 FAILED: a completed task''s reminder was not canceled (status=%)', v_row.status;
  end if;

  select * into v_row from public.scheduled_notifications
   where task_id = (select id from public.tasks where title = 'will be skipped after scheduling');
  if v_row.status <> 'canceled' or v_row.resolved_at is null then
    raise exception 'CASE 8 FAILED: a skipped task''s reminder was not canceled (status=%)', v_row.status;
  end if;
end $$;
do $$ begin raise notice 'CASE 7+8: completed/skipped tasks cancel their pending reminder — OK'; end $$;

-- ── Cases 11-15: claiming itself ─────────────────────────────────────────────────────────────
-- Created fresh here, not in the earlier fixture batch: its whole point is a fire_at already
-- in the past, and reconciliation+claiming happen in the SAME atomic call — creating it any
-- earlier in this script would mean it gets swept up (created AND claimed) by an earlier,
-- unrelated reconcile call before this section ever runs.
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);
select id as due_task_id from public.create_task_with_history(
  :'a_day_id', 'due now', null, 'medium', 'flexible',
  now() + interval '9 minutes', now() + interval '39 minutes', null, 'user'
) \gset

do $$
begin
  if exists (
    select 1 from public.scheduled_notifications
     where task_id = (select id from public.tasks where title = 'due now')
  ) then
    raise exception 'setup failed: "due now" already has a reminder before reconciliation ran';
  end if;
end $$;

set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

do $$
declare v_claimed_ids uuid[];
begin
  select array_agg(id) into v_claimed_ids from public.reconcile_and_claim_notifications();

  -- CASE 11: the due reminder ("due now", fire_at already in the past) was claimed.
  if not (select id from public.scheduled_notifications where task_id = (select id from public.tasks where title = 'due now'))
       = any(v_claimed_ids) then
    raise exception 'CASE 11 FAILED: a due notification was not claimed';
  end if;

  -- CASE 12: the future one ("due later", fire_at still ahead) was NOT claimed.
  if (select id from public.scheduled_notifications where task_id = (select id from public.tasks where title = 'due later'))
       = any(v_claimed_ids) then
    raise exception 'CASE 12 FAILED: a future notification was claimed';
  end if;

  -- CASE 13: the canceled ones were never claimed.
  if (select id from public.scheduled_notifications where task_id = (select id from public.tasks where title = 'will be completed'))
       = any(v_claimed_ids)
     or (select id from public.scheduled_notifications where task_id = (select id from public.tasks where title = 'will be skipped after scheduling')) = any(v_claimed_ids)
  then
    raise exception 'CASE 13 FAILED: a canceled notification was claimed';
  end if;
end $$;
do $$ begin raise notice 'CASE 11+12+13: due is claimed, future and canceled are not — OK'; end $$;

-- CASE 14: the now-claimed row cannot be claimed again by a second invocation this "tick".
do $$
declare v_status_before text; v_claimed_at_before timestamptz; v_attempts_before int;
        v_status_after text; v_claimed_at_after timestamptz; v_attempts_after int;
        v_claimed_ids uuid[];
begin
  select status, claimed_at, attempt_count into v_status_before, v_claimed_at_before, v_attempts_before
    from public.scheduled_notifications where task_id = (select id from public.tasks where title = 'due now');

  select array_agg(id) into v_claimed_ids from public.reconcile_and_claim_notifications();

  select status, claimed_at, attempt_count into v_status_after, v_claimed_at_after, v_attempts_after
    from public.scheduled_notifications where task_id = (select id from public.tasks where title = 'due now');

  if (select id from public.scheduled_notifications where task_id = (select id from public.tasks where title = 'due now'))
       = any(v_claimed_ids) then
    raise exception 'CASE 14 FAILED: an already-claimed notification was claimed again';
  end if;
  if v_status_after <> v_status_before or v_claimed_at_after <> v_claimed_at_before
     or v_attempts_after <> v_attempts_before then
    raise exception 'CASE 14 FAILED: an already-claimed row was mutated by a second claim pass';
  end if;
end $$;
do $$ begin raise notice 'CASE 14: an already-claimed notification cannot be claimed again — OK'; end $$;

-- CASE 15: a terminal (canceled) row is never reachable by the claim, EVEN WHEN its fire_at is
-- already due. This needs its own fixture: 'will be completed' (used just above) was never
-- actually due at cancellation time, so a claim query that wrongly included 'canceled' rows
-- would never have been exercised by it — a real gap this file's own writing caught via
-- mutation testing (see the Phase 6.2 verification report: mutating the claim step to accept
-- 'canceled' rows was NOT caught until this fixture was added). `fire_at` is backdated by hand
-- afterward (simulating time having passed — the same technique case 18 uses for an abandoned
-- claim lease), since a fresh task's fire_at is always still in the future.
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);
select id as due_and_completed_task_id from public.create_task_with_history(
  :'a_day_id', 'due now but completed', null, 'medium', 'flexible',
  now() + interval '15 minutes', now() + interval '45 minutes', null, 'user'
) \gset

set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
select public.reconcile_and_claim_notifications(); -- creates its (not-yet-due) 'scheduled' row

reset role;
update public.scheduled_notifications
   set fire_at = now() - interval '1 minute' -- simulate time having passed since it was scheduled
 where task_id = (select id from public.tasks where title = 'due now but completed');

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);
select public.change_task_status(:'due_and_completed_task_id', 'completed');

set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
do $$
declare v_claimed_ids uuid[];
begin
  -- Cancellation (of a now-due row) and claiming happen in this SAME call — proving a row
  -- canceled mid-cycle is never claimed by that same cycle, not just on a later one.
  select array_agg(id) into v_claimed_ids from public.reconcile_and_claim_notifications();
  if exists (
    select 1 from public.scheduled_notifications
     where task_id = (select id from public.tasks where title = 'due now but completed')
       and id = any(v_claimed_ids)
  ) then
    raise exception 'CASE 15 FAILED: a canceled, already-due notification was claimed';
  end if;
  if (select status from public.scheduled_notifications
       where task_id = (select id from public.tasks where title = 'due now but completed')) <> 'canceled' then
    raise exception 'setup/CASE 7 regression: the due-and-completed fixture was not canceled at all';
  end if;
  if (select id from public.scheduled_notifications where task_id = (select id from public.tasks where title = 'will be completed'))
       = any(v_claimed_ids) then
    raise exception 'CASE 15 FAILED: a terminal (canceled) notification was claimed';
  end if;
end $$;
do $$ begin raise notice 'CASE 15: a terminal notification is never claimable, even when already due — OK'; end $$;

-- ── Case 18: claim lease recovery ────────────────────────────────────────────────────────────
-- Simulate an abandoned claim by hand (as postgres, bypassing the RPC — this is inspecting/
-- forcing internal state for the test, not something application code can do).
reset role;
update public.scheduled_notifications
   set claimed_at = now() - interval '10 minutes' -- older than the 5-minute lease
 where task_id = (select id from public.tasks where title = 'due now') and status = 'claimed';

set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
do $$
declare v_row public.scheduled_notifications; v_claimed_ids uuid[];
begin
  select array_agg(id) into v_claimed_ids from public.reconcile_and_claim_notifications();
  select * into v_row from public.scheduled_notifications
   where task_id = (select id from public.tasks where title = 'due now');
  -- attempt_count was 1 (< 3), so it should have been recovered to 'scheduled' and then
  -- immediately re-claimed by the SAME reconciliation pass (its fire_at is still in the past).
  if v_row.status <> 'claimed' or v_row.attempt_count <> 2 then
    raise exception 'CASE 18 FAILED: an abandoned claim with attempts left was not recovered and reclaimed (status=%, attempts=%)', v_row.status, v_row.attempt_count;
  end if;
  if not v_row.id = any(v_claimed_ids) then
    raise exception 'CASE 18 FAILED: the recovered notification was not returned by this claim pass';
  end if;
end $$;
do $$ begin raise notice 'CASE 18a: an abandoned claim with attempts left is recovered and reclaimed — OK'; end $$;

-- Now exhaust its attempts and confirm it expires instead of recovering forever.
reset role;
update public.scheduled_notifications
   set attempt_count = 3, claimed_at = now() - interval '10 minutes'
 where task_id = (select id from public.tasks where title = 'due now') and status = 'claimed';

set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
do $$
declare v_row public.scheduled_notifications;
begin
  perform public.reconcile_and_claim_notifications();
  select * into v_row from public.scheduled_notifications
   where task_id = (select id from public.tasks where title = 'due now');
  if v_row.status <> 'expired' or v_row.resolved_at is null then
    raise exception 'CASE 18 FAILED: an abandoned claim with no attempts left did not expire (status=%)', v_row.status;
  end if;
end $$;
do $$ begin raise notice 'CASE 18b: an abandoned claim with no attempts left expires, not stuck forever — OK'; end $$;

-- ── Case 26: reconciliation never writes to tasks or task_history ───────────────────────────
do $$
declare v_task_count_before int; v_history_count_before int;
        v_task_count_after int; v_history_count_after int;
        v_task_snapshot record;
begin
  -- The OBSERVATION of task_history needs a superuser: service_role (who runs the reconcile
  -- below) deliberately has no privilege on it (see the Phase 6 service_role hardening
  -- migration). The reconcile call itself still runs as service_role.
  execute 'reset role';
  select count(*) into v_task_count_before from public.tasks;
  select count(*) into v_history_count_before from public.task_history;
  select updated_at, status, scheduled_start into v_task_snapshot
    from public.tasks where title = 'due later';
  execute 'set local role service_role';

  perform public.reconcile_and_claim_notifications();

  execute 'reset role';
  select count(*) into v_task_count_after from public.tasks;
  select count(*) into v_history_count_after from public.task_history;
  if v_task_count_before <> v_task_count_after or v_history_count_before <> v_history_count_after then
    raise exception 'CASE 26 FAILED: reconciliation changed the number of task/task_history rows';
  end if;
  if (select (updated_at, status, scheduled_start) from public.tasks where title = 'due later')
     is distinct from (v_task_snapshot.updated_at, v_task_snapshot.status, v_task_snapshot.scheduled_start) then
    raise exception 'CASE 26 FAILED: reconciliation mutated a task row';
  end if;
  execute 'set local role service_role';
end $$;
do $$ begin raise notice 'CASE 26: reconciliation never mutates tasks or task_history — OK'; end $$;

-- ── Case 19: cross-user isolation on scheduled_notifications' own SELECT policy ─────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);
do $$
begin
  if (select count(*) from public.scheduled_notifications where user_id <> '00000000-0000-0000-0000-0000000000a1') <> 0 then
    raise exception 'CASE 19 FAILED: user A can see a notification not owned by them';
  end if;
  if (select count(*) from public.scheduled_notifications) = 0 then
    raise exception 'CASE 19 FAILED: user A cannot see their own notifications either (setup problem)';
  end if;
end $$;

select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text,
  true);
do $$
begin
  if (select count(*) from public.scheduled_notifications where user_id = '00000000-0000-0000-0000-0000000000a1') <> 0 then
    raise exception 'CASE 19 FAILED: user B can see user A''s notifications';
  end if;
end $$;
do $$ begin raise notice 'CASE 19: cross-user notification access is blocked by RLS — OK'; end $$;

-- ── Case 20: no direct authenticated writes, even to the caller's own row ───────────────────
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);
do $$
declare v_refused boolean := false;
begin
  begin
    insert into public.scheduled_notifications
      (user_id, task_id, day_id, kind, fire_at, task_scheduled_start_snapshot)
    select '00000000-0000-0000-0000-0000000000a1', id, day_id, 'task_reminder', now(), now()
      from public.tasks where title = 'due later';
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then raise exception 'CASE 20 FAILED: a direct INSERT was allowed'; end if;
end $$;
do $$
declare v_refused boolean := false;
begin
  begin
    update public.scheduled_notifications set attempt_count = 99
     where task_id = (select id from public.tasks where title = 'due later');
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then raise exception 'CASE 20 FAILED: a direct UPDATE was allowed'; end if;
end $$;
do $$
declare v_refused boolean := false;
begin
  begin
    delete from public.scheduled_notifications where task_id = (select id from public.tasks where title = 'due later');
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then raise exception 'CASE 20 FAILED: a direct DELETE was allowed'; end if;
end $$;
do $$ begin raise notice 'CASE 20: no direct authenticated writes, even on the caller''s own row — OK'; end $$;

-- ── Cases 21-22: neither anon nor an ordinary authenticated user can invoke the system RPC ──
do $$
declare v_refused boolean := false;
begin
  begin
    perform public.reconcile_and_claim_notifications();
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then raise exception 'CASE 22 FAILED: an ordinary authenticated user could call the system RPC'; end if;
end $$;
do $$ begin raise notice 'CASE 22: an ordinary authenticated user cannot invoke the claim RPC — OK'; end $$;

reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;
do $$
declare v_refused boolean := false;
begin
  begin
    perform public.reconcile_and_claim_notifications();
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then raise exception 'CASE 21 FAILED: anon could call the system RPC'; end if;
end $$;
do $$ begin raise notice 'CASE 21: anon cannot invoke the claim RPC — OK'; end $$;
reset role;

-- The internal check, exercised directly: superuser bypasses grants, but the wrong (or
-- missing) JWT role claim is still refused by the function body itself — the same
-- defense-in-depth pattern proven for push_subscriptions in Phase 6.1.
select set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
do $$
declare v_refused boolean := false;
begin
  begin
    perform public.reconcile_and_claim_notifications();
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then
    raise exception 'CASE 17 FAILED: the RPC succeeded for a superuser without a service_role JWT claim';
  end if;
end $$;
do $$ begin raise notice 'CASE 17: the RPC''s own auth.role() = service_role check is real, independent of grants — OK'; end $$;

-- ── Grants / SECURITY DEFINER / search_path / SKIP LOCKED presence ──────────────────────────
do $$
declare v_secdef boolean; v_config text[]; v_def text;
begin
  select prosecdef, proconfig into v_secdef, v_config
    from pg_proc where proname = 'reconcile_and_claim_notifications' and pronamespace = 'public'::regnamespace;
  if not v_secdef then raise exception 'FAILED: reconcile_and_claim_notifications is not SECURITY DEFINER'; end if;
  if not exists (select 1 from unnest(v_config) c where c in ('search_path=""', 'search_path=')) then
    raise exception 'FAILED: reconcile_and_claim_notifications does not set search_path to empty (saw %)', v_config;
  end if;

  select pg_get_functiondef(oid) into v_def
    from pg_proc where proname = 'reconcile_and_claim_notifications' and pronamespace = 'public'::regnamespace;
  if v_def !~* 'for update skip locked' then
    raise exception 'FAILED: reconcile_and_claim_notifications does not use FOR UPDATE SKIP LOCKED';
  end if;
end $$;
do $$ begin raise notice 'CASE: SECURITY DEFINER + search_path='''' + FOR UPDATE SKIP LOCKED all present — OK'; end $$;

do $$
declare
  v_table_privs text[];
  v_authenticated_execute int;
  v_anon_execute int;
  v_service_role_execute int;
begin
  select array_agg(privilege_type order by privilege_type) into v_table_privs
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'scheduled_notifications' and grantee = 'authenticated';
  if v_table_privs <> array['SELECT'] then
    raise exception 'FAILED: authenticated''s table privileges on scheduled_notifications are % (expected only SELECT)', v_table_privs;
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'scheduled_notifications' and grantee = 'anon'
  ) then
    raise exception 'FAILED: anon has some grant on scheduled_notifications (expected none)';
  end if;

  select count(*) into v_authenticated_execute from information_schema.role_routine_grants
   where routine_schema = 'public' and routine_name = 'reconcile_and_claim_notifications'
     and grantee = 'authenticated';
  select count(*) into v_anon_execute from information_schema.role_routine_grants
   where routine_schema = 'public' and routine_name = 'reconcile_and_claim_notifications'
     and grantee = 'anon';
  select count(*) into v_service_role_execute from information_schema.role_routine_grants
   where routine_schema = 'public' and routine_name = 'reconcile_and_claim_notifications'
     and grantee = 'service_role' and privilege_type = 'EXECUTE';

  if v_authenticated_execute <> 0 then raise exception 'FAILED: authenticated has a grant on the system RPC'; end if;
  if v_anon_execute <> 0 then raise exception 'FAILED: anon has a grant on the system RPC'; end if;
  if v_service_role_execute <> 1 then raise exception 'FAILED: service_role does not have exactly one EXECUTE grant on the system RPC'; end if;
end $$;
do $$ begin raise notice 'CASE: grants are EXECUTE-only for service_role, nothing for anon/authenticated — OK'; end $$;

do $$
begin
  raise notice 'SCHEDULED NOTIFICATIONS ISOLATION OK';
end $$;

rollback;
