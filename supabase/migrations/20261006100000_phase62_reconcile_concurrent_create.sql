-- ─────────────────────────────────────────────────────────────────────────
-- Phase 6.2 follow-up (found by Phase 6 live verification): overlapping cron invocations.
--
-- A real two-connection test (one transaction claiming and holding its locks, a second invocation
-- fired while it was open) showed no double-claim — FOR UPDATE SKIP LOCKED does its job — but
-- exposed a different race in step 4: both invocations see the same brand-new, in-horizon task
-- with no reminder yet and both INSERT one. The second blocks on the first's uncommitted index
-- entry and then fails with a unique violation on scheduled_notifications_one_active_per_task_kind,
-- aborting that whole invocation (the cron route would return 500 for that tick; the next minute's
-- tick recovers). Harmless to correctness — the unique index did its job as the backstop — but
-- contradicts "repeated cron invocation is safe", and the original comment even claimed the
-- backstop "practically never fires".
--
-- The fix is one clause: `on conflict (task_id, kind) where status in ('scheduled','claimed') do
-- nothing` on step 4's insert (the conflicting row IS the active reminder). Everything else in the
-- function below is byte-for-byte the Phase 6.2 definition; CREATE OR REPLACE keeps its owner and
-- its service_role-only grants. See supabase/tests/concurrent_cron_claims.sh for the real
-- two-connection regression.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.reconcile_and_claim_notifications()
returns setof public.scheduled_notifications
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  -- 1a. Abandoned claims with attempts remaining go back to `scheduled`, to be claimed again.
  update public.scheduled_notifications
     set status = 'scheduled', claimed_at = null, updated_at = now()
   where status = 'claimed'
     and claimed_at < now() - interval '5 minutes'
     and attempt_count < 3;

  -- 1b. Abandoned claims with no attempts left are given up on — never retried again.
  -- claimed_at is cleared here, not just resolved_at set: the table's own CHECK constraint
  -- requires claimed_at to be null whenever status isn't 'claimed', and this is a real
  -- transition off of 'claimed' — real Postgres verification (not a mocked TS test) is what
  -- caught this originally missing.
  update public.scheduled_notifications
     set status = 'expired', claimed_at = null, resolved_at = now(), updated_at = now()
   where status = 'claimed'
     and claimed_at < now() - interval '5 minutes'
     and attempt_count >= 3;

  -- 2. Any still-`scheduled` row whose task's schedule has changed since it was last computed
  --    is corrected IN PLACE — this is what makes a reschedule "reconcile the pending reminder
  --    to the new scheduled_start" without touching reschedule_task() itself. A `claimed` row
  --    is intentionally left alone here: it is not currently claimable regardless (see
  --    invariant 4 — "not claimable" is already true for anything not `scheduled`), and if it
  --    is truly abandoned it is recovered by step 1 on a later cycle, after which step 4 below
  --    creates a fresh, correctly-scheduled row for it.
  update public.scheduled_notifications sn
     set fire_at = t.scheduled_start - interval '10 minutes',
         task_scheduled_start_snapshot = t.scheduled_start,
         updated_at = now()
    from public.tasks t
   where sn.task_id = t.id
     and sn.status = 'scheduled'
     and sn.task_scheduled_start_snapshot <> t.scheduled_start;

  -- 3. A `scheduled` reminder whose task is no longer upcoming (completed, skipped, or any
  --    future terminal status — this is deliberately "not upcoming", not an enumerated list,
  --    so it needs no change if a new terminal status is ever added to `tasks`) is canceled.
  --    A `claimed` row is left alone for the same reason as step 2.
  update public.scheduled_notifications sn
     set status = 'canceled', resolved_at = now(), updated_at = now()
    from public.tasks t
   where sn.task_id = t.id
     and sn.status = 'scheduled'
     and t.status <> 'upcoming';

  -- 4. A fresh reminder for every upcoming task inside the scheduling horizon that does not
  --    already have an active one. The horizon only gates CREATION of a new row — an existing
  --    active row is kept in sync by step 2 regardless of horizon, so a reminder already
  --    created never goes stale just because its task was later pushed further out. The
  --    partial unique index above is the hard backstop against a duplicate; this `not exists`
  --    is what makes that backstop practically never fire.
  insert into public.scheduled_notifications
    (user_id, task_id, day_id, kind, fire_at, task_scheduled_start_snapshot, status)
  select t.user_id, t.id, t.day_id, 'task_reminder',
         t.scheduled_start - interval '10 minutes', t.scheduled_start, 'scheduled'
    from public.tasks t
   where t.status = 'upcoming'
     and t.scheduled_start >= now()
     and t.scheduled_start < now() + interval '24 hours'
     and not exists (
       select 1 from public.scheduled_notifications sn
        where sn.task_id = t.id and sn.kind = 'task_reminder'
          and sn.status in ('scheduled', 'claimed')
     )
  -- Phase 6 live verification: two overlapping invocations that both find the same brand-new
  -- task each try this insert; the loser used to die with a unique violation on
  -- scheduled_notifications_one_active_per_task_kind (found by a real two-connection test).
  -- The row the winner inserted IS the active reminder, so doing nothing is exactly right.
  on conflict (task_id, kind) where status in ('scheduled', 'claimed') do nothing;

  -- 5. Claim whatever is due right now. FOR UPDATE SKIP LOCKED is what makes two concurrent
  --    invocations of this same function (e.g. an overlapping cron tick) partition the
  --    claimable set instead of ever claiming the same row twice.
  return query
    update public.scheduled_notifications
       set status = 'claimed', claimed_at = now(), attempt_count = attempt_count + 1,
           updated_at = now()
     where id in (
       select id from public.scheduled_notifications
        where status = 'scheduled' and fire_at <= now()
        for update skip locked
     )
    returning *;
end;
$$;
