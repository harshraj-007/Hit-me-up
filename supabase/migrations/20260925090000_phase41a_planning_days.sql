-- ─────────────────────────────────────────────────────────────────────────
-- Phase 4.1a: cross-midnight tasks + future-day planning — the ADDITIVE half.
--
-- Safe to apply while the currently deployed application is still running: nothing here
-- removes a privilege or a policy the app uses today (that is migration 4.1b, applied only
-- after the new application code is live).
--
-- 1. tasks_duration_max: a task lasts at most 24 hours. Validated against existing rows; the
--    migration fails atomically if any row violates it.
-- 2. ensure_day(date): the ONLY application write path that creates a planning day, its plan
--    and revision 1. The timezone always comes from the caller's profile (never the client) and
--    is FROZEN on the row when it is first created — an existing day is never touched. Dates are
--    limited to today … today + 365 (inclusive), "today" being resolved in SQL from the profile.
-- 3. create_task_with_history (same signature): the start must be inside the planning day, the
--    end after the start, the duration ≤ 24h, and the day not already over. The END may cross
--    midnight and the task stays on its planning day.
-- 4. reschedule_task (same signature): same window rule; no longer requires the end to be
--    inside the day.
--
-- apply_replan is unchanged: it only writes windows fully inside the planning day, so the
-- planner never creates a cross-midnight placement.
--
-- All three functions stay SECURITY DEFINER, `set search_path = ''`, authenticated-only, with
-- explicit auth.uid() checks and no dynamic SQL. (Both redefined functions keep the grants they
-- already have; ensure_day's are set below.)
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. maximum duration ─────────────────────────────────────────────────
alter table public.tasks
  add constraint tasks_duration_max
  check (scheduled_end - scheduled_start <= interval '24 hours');

-- ── 2. ensure_day ───────────────────────────────────────────────────────
-- Errors:  42501 not authenticated · P0002 no profile (timezone not reported yet) ·
--          22023 unknown timezone, or a date outside today … today + 365
create function public.ensure_day(p_local_date date default null)
returns public.days
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_tz    text;
  v_today date;
  v_day   public.days;
  v_plan  uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select timezone into v_tz from public.profiles where id = v_uid;
  if not found then
    raise exception 'timezone not reported yet' using errcode = 'P0002';
  end if;

  -- The timezone must be one Postgres itself understands (it is what interprets the day's bounds).
  begin
    perform now() at time zone v_tz;
  exception when others then
    raise exception 'unknown timezone' using errcode = '22023';
  end;

  v_today := (now() at time zone v_tz)::date;
  if p_local_date is null then
    p_local_date := v_today;
  end if;
  if p_local_date < v_today or p_local_date > v_today + 365 then
    raise exception 'date is outside the planning horizon' using errcode = '22023';
  end if;

  -- Fast path: everything already exists, so a steady-state page load writes nothing.
  select * into v_day from public.days where user_id = v_uid and local_date = p_local_date;
  if found then
    select id into v_plan from public.plans where day_id = v_day.id;
    if v_plan is not null
       and exists (select 1 from public.plan_revisions where plan_id = v_plan) then
      return v_day;
    end if;
  end if;

  -- Create only what is missing. The unique constraints (days_user_date_unique, plans_day_unique,
  -- plan_revisions_number_unique) make this race-safe: a concurrent caller's insert is a no-op.
  -- An existing day's timezone is NEVER updated.
  if v_day.id is null then
    insert into public.days (user_id, local_date, timezone)
    values (v_uid, p_local_date, v_tz)
    on conflict (user_id, local_date) do nothing;
    select * into v_day from public.days where user_id = v_uid and local_date = p_local_date;
  end if;

  insert into public.plans (user_id, day_id)
  values (v_uid, v_day.id)
  on conflict (day_id) do nothing;
  select id into v_plan from public.plans where day_id = v_day.id;

  insert into public.plan_revisions (plan_id, user_id, revision_number, source)
  select v_plan, v_uid, 1, 'system'
   where not exists (select 1 from public.plan_revisions where plan_id = v_plan)
  on conflict (plan_id, revision_number) do nothing;

  return v_day;
end;
$$;

revoke execute on function public.ensure_day(date) from public, anon;
grant  execute on function public.ensure_day(date) to authenticated;

-- ── 3. create_task_with_history ─────────────────────────────────────────
create or replace function public.create_task_with_history(
  p_day_id          uuid,
  p_title           text,
  p_notes           text,
  p_priority        text,
  p_kind            text,
  p_scheduled_start timestamptz,
  p_scheduled_end   timestamptz,
  p_due_at          timestamptz,
  p_source          text default 'user'
)
returns public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks;
  v_day  public.days;
  v_ds   timestamptz;
  v_de   timestamptz;
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  -- Only the user's own tasks can be created here; planner-sourced tasks are not
  -- creatable through any API-reachable path.
  if p_source is distinct from 'user' then
    raise exception 'tasks created through the API must have source user' using errcode = '22023';
  end if;

  select * into v_day
    from public.days
   where id = p_day_id and user_id = (select auth.uid());
  if not found then
    raise exception 'day % not found for current user', p_day_id
      using errcode = 'P0002';
  end if;

  -- The day's own local bounds, from the timezone FROZEN on the day row when it was created.
  -- The client supplies no timezone and no bounds.
  v_ds := v_day.local_date::timestamp at time zone v_day.timezone;
  v_de := (v_day.local_date + 1)::timestamp at time zone v_day.timezone;

  if v_de <= now() then
    raise exception 'that planning day is already over' using errcode = '22023';
  end if;
  -- Start inside the planning day; end after start; at most 24 hours. The END may cross
  -- midnight: the task stays on this day.
  if p_scheduled_start is null or p_scheduled_end is null
     or p_scheduled_start < v_ds or p_scheduled_start >= v_de then
    raise exception 'start must be inside the planning day' using errcode = '22023';
  end if;
  if p_scheduled_end <= p_scheduled_start then
    raise exception 'end must be after start' using errcode = '22023';
  end if;
  if p_scheduled_end - p_scheduled_start > interval '24 hours' then
    raise exception 'a task can last at most 24 hours' using errcode = '22023';
  end if;

  insert into public.tasks (
    user_id, day_id, title, notes, priority, kind,
    scheduled_start, scheduled_end, due_at, source
  )
  values (
    (select auth.uid()), p_day_id, p_title, p_notes, p_priority, p_kind,
    p_scheduled_start, p_scheduled_end, p_due_at, p_source
  )
  returning * into v_task;

  insert into public.task_history (task_id, user_id, previous_status, new_status, source, event)
  values (v_task.id, v_task.user_id, null, v_task.status, 'user', 'created');

  return v_task;
end;
$$;

-- ── 4. reschedule_task ──────────────────────────────────────────────────
create or replace function public.reschedule_task(
  p_task_id uuid,
  p_start   timestamptz,
  p_end     timestamptz
)
returns public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old        public.tasks;
  v_task       public.tasks;
  v_day        public.days;
  v_day_start  timestamptz;
  v_day_end    timestamptz;
  v_plan_id    uuid;
  v_rev_number integer;
  v_rev_id     uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'invalid window' using errcode = '22023';
  end if;

  select * into v_old
    from public.tasks
   where id = p_task_id
     and user_id = (select auth.uid())
     and status = 'upcoming'
     for update;
  if not found then
    raise exception 'task % is not in a state that can change (missing, not yours, or already resolved)', p_task_id
      using errcode = 'P0002';
  end if;

  select * into v_day
    from public.days
   where id = v_old.day_id and user_id = (select auth.uid());
  if not found then
    raise exception 'day not found for current user' using errcode = 'P0002';
  end if;

  -- The task's own local day, DST-aware, from the timezone frozen on the day row.
  v_day_start := v_day.local_date::timestamp at time zone v_day.timezone;
  v_day_end   := (v_day.local_date + 1)::timestamp at time zone v_day.timezone;
  -- The START must be inside the task's planning day; the END may cross midnight (the task
  -- stays on this day). No "day already over" rule here: a previous day's running task can
  -- still be moved. The service keeps the "ends in the past" rule.
  if p_start < v_day_start or p_start >= v_day_end then
    raise exception 'start must be inside the task''s planning day' using errcode = '22023';
  end if;
  if p_end - p_start > interval '24 hours' then
    raise exception 'a task can last at most 24 hours' using errcode = '22023';
  end if;

  -- Nothing about the schedule changes: at most pin it, and write no history or revision.
  if date_trunc('milliseconds', v_old.scheduled_start) = date_trunc('milliseconds', p_start)
     and date_trunc('milliseconds', v_old.scheduled_end) = date_trunc('milliseconds', p_end)
     and not v_old.unscheduled then
    if not v_old.schedule_locked then
      update public.tasks set schedule_locked = true where id = v_old.id returning * into v_task;
      return v_task;
    end if;
    return v_old;
  end if;

  select id into v_plan_id
    from public.plans
   where day_id = v_old.day_id and user_id = (select auth.uid());
  if v_plan_id is null then
    raise exception 'no plan for this day' using errcode = 'P0002';
  end if;

  select coalesce(max(revision_number), 0) + 1 into v_rev_number
    from public.plan_revisions where plan_id = v_plan_id;
  insert into public.plan_revisions (plan_id, user_id, revision_number, source)
  values (v_plan_id, (select auth.uid()), v_rev_number, 'user')
  returning id into v_rev_id;

  update public.tasks
     set scheduled_start = p_start,
         scheduled_end = p_end,
         schedule_locked = true,
         unscheduled = false
   where id = v_old.id
  returning * into v_task;

  insert into public.task_history (
    task_id, user_id, previous_status, new_status, source, event,
    previous_start, previous_end, new_start, new_end,
    previous_unscheduled, new_unscheduled, revision_id
  )
  values (
    v_task.id, v_task.user_id, 'upcoming', 'upcoming', 'user', 'rescheduled',
    v_old.scheduled_start, v_old.scheduled_end, v_task.scheduled_start, v_task.scheduled_end,
    v_old.unscheduled, false, v_rev_id
  );

  return v_task;
end;
$$;
