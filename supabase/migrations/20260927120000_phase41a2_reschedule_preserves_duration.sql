-- ─────────────────────────────────────────────────────────────────────────
-- Phase 4.1a-2: rescheduling preserves a task's duration (found during Gate H).
--
-- A task's duration is not stored as a value — it is `scheduled_end - scheduled_start`. Until
-- now every layer accepted a free end time on reschedule, so a reschedule could silently resize
-- a task. The application now sends only the NEW START and derives `end = start + stored
-- duration`; this migration makes the database enforce the same rule so it holds for any caller,
-- including a direct call to the RPC.
--
-- Only reschedule_task() changes: same signature, same SECURITY DEFINER / empty search_path /
-- authenticated-only EXECUTE / explicit auth.uid() checks / no dynamic SQL, same ownership,
-- terminal-state, lock, planning-day and revision/history behavior. The one addition is the
-- duration check (errcode 22023). Grants are preserved by CREATE OR REPLACE.
--
-- apply_replan() is deliberately untouched (its planner already preserves durations).
-- Additive and non-destructive: no table, column, constraint, policy or privilege changes.
-- ─────────────────────────────────────────────────────────────────────────

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

  -- Rescheduling MOVES a task; it never resizes it. The new window must be exactly as long as the
  -- stored one (to within 2 ms — the precision the application works in), so neither the UI, the
  -- service nor a direct call to this function can lengthen or shorten a task by rescheduling it.
  if abs(extract(epoch from ((p_end - p_start) - (v_old.scheduled_end - v_old.scheduled_start)))) >= 0.002 then
    raise exception 'rescheduling cannot change a task''s duration' using errcode = '22023';
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
