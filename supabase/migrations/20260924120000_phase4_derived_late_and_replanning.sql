-- ─────────────────────────────────────────────────────────────────────────
-- Phase 4: derived "late", manual rescheduling, deterministic replanning.
--
-- Non-destructive: no table, column or row is dropped. Applies on top of the two Phase 3
-- migrations without modifying them.
--
-- 1. "late" stops being a stored status. It is derived from the clock (now >= scheduled_end
--    while still unresolved), so an overdue task stays reschedulable and replannable. Any
--    row that was manually marked 'late' under the old model is normalised back to
--    'upcoming' (its title, times and history are kept, and the normalisation itself is
--    written to task_history as a 'system' event — nothing is silently lost).
-- 2. tasks gains `schedule_locked` (the user moved it by hand; replanning must never undo
--    that) and `unscheduled` (replanning could not fit it in the remaining day; it keeps its
--    old times and is never deleted or shortened).
-- 3. task_history learns what kind of event a row is, and records old/new schedule and the
--    plan revision that produced it. Still append-only: no UPDATE/DELETE policy is added.
-- 4. The write path is closed. `authenticated`/`anon` lose INSERT/UPDATE/DELETE on `tasks`
--    and INSERT/UPDATE/DELETE on `task_history` (and the matching RLS policies are dropped),
--    so a user calling PostgREST directly can no longer edit status, source, day_id, the
--    schedule, `schedule_locked` or `unscheduled`, nor forge history. The ONLY writers are
--    four RPCs — create_task_with_history, change_task_status, reschedule_task, apply_replan.
--
--    Why SECURITY DEFINER (a change from Phase 3's SECURITY INVOKER): an INVOKER function
--    runs with the caller's own privileges, so any grant that lets the RPC write a column lets
--    a direct UPDATE write it too — column-level grants cannot tell the two apart (verified in
--    scratch Postgres). A DEFINER function runs as its owner, so the callers themselves need
--    no write privilege at all. Because the owner bypasses RLS, every statement in these
--    functions filters on `(select auth.uid())` explicitly, `search_path` is pinned to '' (all
--    objects are schema-qualified), a missing caller is refused, and EXECUTE is granted to
--    `authenticated` only. They also enforce the atomicity of task + history + revision.
-- 5. change_task_status() no longer accepts 'late'; create_task_with_history() records
--    event = 'created' and only ever creates source = 'user' tasks.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1/2. new task columns ───────────────────────────────────────────────
alter table public.tasks
  add column schedule_locked boolean not null default false,
  add column unscheduled     boolean not null default false;

-- ── 3. task_history: event kind, schedule delta, revision link ───────────
alter table public.task_history
  add column event              text not null default 'status_changed',
  add column previous_start     timestamptz,
  add column previous_end       timestamptz,
  add column new_start          timestamptz,
  add column new_end            timestamptz,
  add column previous_unscheduled boolean,
  add column new_unscheduled    boolean,
  add column revision_id        uuid references public.plan_revisions (id) on delete set null;

-- Existing rows: the row written at task creation has no previous status.
update public.task_history set event = 'created' where previous_status is null;

alter table public.task_history
  add constraint task_history_event_check
    check (event in ('created', 'status_changed', 'rescheduled', 'replanned')),
  add constraint task_history_schedule_event_complete
    check (
      event not in ('rescheduled', 'replanned')
      or (previous_start is not null and previous_end is not null
          and new_start is not null and new_end is not null
          and previous_unscheduled is not null and new_unscheduled is not null
          and revision_id is not null)
    );

-- ── 1. normalise legacy manual 'late' rows, then forbid the status ───────
insert into public.task_history (task_id, user_id, previous_status, new_status, source, event)
select id, user_id, 'late', 'upcoming', 'system', 'status_changed'
  from public.tasks
 where status = 'late';

update public.tasks
   set status = 'upcoming',
       completed_at = null
 where status = 'late';

alter table public.tasks drop constraint tasks_status_check;
alter table public.tasks
  add constraint tasks_status_check check (status in ('upcoming', 'completed', 'skipped')),
  -- A resolved task holds no unscheduled flag.
  add constraint tasks_unscheduled_only_when_unresolved check (not unscheduled or status = 'upcoming');

-- task_history keeps accepting 'late' in previous_status/new_status: rows recorded under the
-- old model (and the normalisation rows above) legitimately mention it, and history is never
-- rewritten.

-- ── 5. create_task_with_history: same signature, now records event = 'created' ──
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
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  -- Only the user's own tasks can be created here; planner-sourced tasks are not
  -- creatable through any API-reachable path.
  if p_source is distinct from 'user' then
    raise exception 'tasks created through the API must have source user' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.days where id = p_day_id and user_id = (select auth.uid())
  ) then
    raise exception 'day % not found for current user', p_day_id
      using errcode = 'P0002';
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

-- ── 5. change_task_status: completed | skipped only ─────────────────────
create or replace function public.change_task_status(
  p_task_id    uuid,
  p_new_status text
)
returns public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks;
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_new_status not in ('completed', 'skipped') then
    raise exception 'invalid target status: %', p_new_status
      using errcode = '22023'; -- invalid_parameter_value
  end if;

  update public.tasks
     set status = p_new_status,
         completed_at = case when p_new_status = 'completed' then now() else null end,
         unscheduled = false
   where id = p_task_id
     and user_id = (select auth.uid())
     and status = 'upcoming'
  returning * into v_task;

  if not found then
    raise exception 'task % is not in a state that can change (missing, not yours, or already resolved)', p_task_id
      using errcode = 'P0002'; -- no_data_found
  end if;

  insert into public.task_history (task_id, user_id, previous_status, new_status, source, event)
  values (v_task.id, v_task.user_id, 'upcoming', v_task.status, 'user', 'status_changed');

  return v_task;
end;
$$;

-- ── 4. reschedule_task ──────────────────────────────────────────────────
-- Moves one unresolved task the caller owns to [p_start, p_end), pins it against automatic
-- replanning, and — only if the schedule really changed — appends a 'rescheduled' history
-- row and a 'user' plan revision, all in one transaction. Errors:
--   22023  invalid window, or the window is outside the task's local day
--   P0002  task missing / not the caller's / already resolved, or the day has no plan
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

  -- The task's own local day, DST-aware, from the timezone stored on the day.
  v_day_start := v_day.local_date::timestamp at time zone v_day.timezone;
  v_day_end   := (v_day.local_date + 1)::timestamp at time zone v_day.timezone;
  if p_start < v_day_start or p_end > v_day_end then
    raise exception 'window is outside the task''s day' using errcode = '22023';
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

-- ── 4. apply_replan ─────────────────────────────────────────────────────
-- Applies a replan computed by the application (the pure planner in src/domain/scheduling).
-- p_changes is a JSON array of
--   { task_id, previous_start, previous_end, previous_unscheduled,
--     new_start, new_end, new_unscheduled }
-- and each element is applied only if the row STILL looks exactly like `previous_*` — so a
-- plan computed from a stale read cannot overwrite something that changed in between. It also
-- only ever touches rows that are the caller's, on the given day, unresolved, planner-sourced
-- and not locked. If any element fails, everything rolls back. On success it appends ONE
-- 'system' revision and one 'replanned' history row per task, and returns the revision
-- number; an empty array changes nothing and returns NULL.
--   22023  malformed input, or a new window outside the day
--   P0002  day/plan not the caller's
--   40001  a task no longer matches what the replan was computed from (retry)
create or replace function public.apply_replan(
  p_day_id  uuid,
  p_changes jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day        public.days;
  v_day_start  timestamptz;
  v_day_end    timestamptz;
  v_plan_id    uuid;
  v_rev_number integer;
  v_rev_id     uuid;
  v_change     jsonb;
  v_old        public.tasks;
  v_new_start  timestamptz;
  v_new_end    timestamptz;
  v_new_unsch  boolean;
  v_changed    boolean := false;
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 500 then
    raise exception 'p_changes must be a JSON array of at most 500 changes' using errcode = '22023';
  end if;
  if jsonb_array_length(p_changes) = 0 then
    return null;
  end if;

  select * into v_day
    from public.days
   where id = p_day_id and user_id = (select auth.uid());
  if not found then
    raise exception 'day % not found for current user', p_day_id using errcode = 'P0002';
  end if;

  select id into v_plan_id
    from public.plans
   where day_id = p_day_id and user_id = (select auth.uid());
  if v_plan_id is null then
    raise exception 'no plan for this day' using errcode = 'P0002';
  end if;

  v_day_start := v_day.local_date::timestamp at time zone v_day.timezone;
  v_day_end   := (v_day.local_date + 1)::timestamp at time zone v_day.timezone;

  for v_change in select * from jsonb_array_elements(p_changes) loop
    if v_change->>'task_id' is null
       or v_change->>'previous_start' is null or v_change->>'previous_end' is null
       or v_change->>'previous_unscheduled' is null
       or v_change->>'new_start' is null or v_change->>'new_end' is null
       or v_change->>'new_unscheduled' is null then
      raise exception 'malformed change' using errcode = '22023';
    end if;

    select * into v_old
      from public.tasks
     where id = (v_change->>'task_id')::uuid
       and user_id = (select auth.uid())
       and day_id = p_day_id
       and status = 'upcoming'
       and source = 'planner'
       and not schedule_locked
       and date_trunc('milliseconds', scheduled_start) = (v_change->>'previous_start')::timestamptz
       and date_trunc('milliseconds', scheduled_end)   = (v_change->>'previous_end')::timestamptz
       and unscheduled = (v_change->>'previous_unscheduled')::boolean
       for update;
    if not found then
      raise exception 'a task changed since this replan was computed' using errcode = '40001';
    end if;

    v_new_unsch := (v_change->>'new_unscheduled')::boolean;
    if v_new_unsch then
      -- Could not fit: the times stay exactly as they were, only the flag flips.
      v_new_start := v_old.scheduled_start;
      v_new_end   := v_old.scheduled_end;
    else
      v_new_start := (v_change->>'new_start')::timestamptz;
      v_new_end   := (v_change->>'new_end')::timestamptz;
      if v_new_end <= v_new_start or v_new_start < v_day_start or v_new_end > v_day_end then
        raise exception 'new window is invalid or outside the day' using errcode = '22023';
      end if;
    end if;

    -- Skip rows that would not actually change anything.
    continue when v_new_start = v_old.scheduled_start
              and v_new_end = v_old.scheduled_end
              and v_new_unsch = v_old.unscheduled;

    if not v_changed then
      select coalesce(max(revision_number), 0) + 1 into v_rev_number
        from public.plan_revisions where plan_id = v_plan_id;
      insert into public.plan_revisions (plan_id, user_id, revision_number, source)
      values (v_plan_id, (select auth.uid()), v_rev_number, 'system')
      returning id into v_rev_id;
      v_changed := true;
    end if;

    update public.tasks
       set scheduled_start = v_new_start,
           scheduled_end = v_new_end,
           unscheduled = v_new_unsch
     where id = v_old.id;

    insert into public.task_history (
      task_id, user_id, previous_status, new_status, source, event,
      previous_start, previous_end, new_start, new_end,
      previous_unscheduled, new_unscheduled, revision_id
    )
    values (
      v_old.id, v_old.user_id, 'upcoming', 'upcoming', 'system', 'replanned',
      v_old.scheduled_start, v_old.scheduled_end, v_new_start, v_new_end,
      v_old.unscheduled, v_new_unsch, v_rev_id
    );
  end loop;

  return case when v_changed then v_rev_number else null end;
end;
$$;

-- ── close the direct write path ─────────────────────────────────────────
-- Privileges AND policies, so it takes two mistakes to reopen. SELECT stays (RLS-scoped).
drop policy "tasks: insert own"        on public.tasks;
drop policy "tasks: update own"        on public.tasks;
drop policy "task_history: insert own" on public.task_history;

-- Revoke everything (Supabase's default grants also include REFERENCES and TRIGGER, and
-- `anon` SELECT), then give `authenticated` back SELECT only. `service_role` is untouched.
revoke all on public.tasks, public.task_history from anon, authenticated;
grant select on public.tasks, public.task_history to authenticated;

-- ── grants: authenticated only ──────────────────────────────────────────
-- Supabase's default privileges hand EXECUTE on new public functions to `anon` separately
-- from PUBLIC (see 20260922130000_lock_down_task_rpcs.sql), so revoke both explicitly. The
-- redefined functions above keep the grants they already had.
revoke execute on function public.reschedule_task(uuid, timestamptz, timestamptz) from public, anon;
grant  execute on function public.reschedule_task(uuid, timestamptz, timestamptz) to authenticated;

revoke execute on function public.apply_replan(uuid, jsonb) from public, anon;
grant  execute on function public.apply_replan(uuid, jsonb) to authenticated;
