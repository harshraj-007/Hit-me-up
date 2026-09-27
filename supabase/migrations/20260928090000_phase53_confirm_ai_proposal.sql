-- ─────────────────────────────────────────────────────────────────────────
-- Phase 5.3: confirm_ai_proposal() — the human-confirmed AI proposal → atomic
-- database mutation boundary.
--
-- This is the FIRST migration that lets an AI-derived proposal cause a mutation. The AI itself
-- is still given no privilege: src/server/ai/* never touches Postgres, and everything it
-- produces is untrusted until a human confirms it (Phase 5.0-5.2, unchanged by this file).
-- What this migration adds is the confirmation boundary — a SECURITY DEFINER function that
-- takes a confirmed proposal and independently re-derives, in SQL, every fact the confirmation
-- relies on: ownership, current task state, the current plan revision, the resulting schedule's
-- conflicts and each task's duration. The Phase 5.2 ValidationResult the caller computed is
-- NOT trusted here — see the function body.
--
-- 1. task_history.source and plan_revisions.source gain a third allowed value, 'ai' — the
--    smallest schema change that lets history/revisions distinguish a human-confirmed AI
--    change from an ordinary user action ('user') or the deterministic planner ('system').
--    Both check constraints are additive (widened, not narrowed); the existing 'created'/
--    'status_changed'/'rescheduled'/'replanned' event vocabulary already represents both an
--    AI-confirmed move and an AI-confirmed unschedule (event = 'rescheduled' either way — the
--    schedule-relevant columns, including `new_unscheduled`, change; nothing new is needed).
-- 2. confirm_ai_proposal(p_day_id, p_base_revision, p_changes) is the new, and only, way an
--    AI-confirmed change reaches the database. `p_changes` is a JSON array of
--      { ref, task_id, type: 'move' | 'unschedule', new_start? }
--    `ref` is carried through only for the resulting task_history's benefit-free audit value
--    and is NEVER used to look up a task — see "ref vs task_id" below. `task_id` is what the
--    trusted server itself resolved during Phase 5.2 proposal generation and returned to the
--    confirming caller; it authorizes nothing by itself; a `move`'s `new_start` is the only
--    schedule input accepted — there is no `new_end` and no duration field, so a proposal
--    literally cannot express a duration change through this function. The end is always
--    `new_start + (the task's CURRENT stored duration, re-read inside this function)`.
--
--    Ref vs task_id: an earlier design tried resolving `ref` (t1, t2, ...) back to a task by
--    rebuilding the day's alias assignment fresh at confirmation time. That is unsound: a task
--    created or completed between proposal generation and confirmation shifts every later
--    alias (aliases are assigned by sorted position, not by identity — see
--    src/domain/ai-planning/aliases.ts), silently reassigning "t1" to a different task than the
--    one the user reviewed and approved, with no error. There is also no revision bump for
--    exactly the events that cause this (task creation; change_task_status; a reschedule_task
--    call that only pins a lock). Resolving through the caller-supplied `task_id` instead —
--    the same shape reschedule_task() already accepts and treats as nothing more than "which
--    row" — sidesteps that gap entirely: this function still independently re-verifies
--    ownership and full current-state eligibility for that exact row before touching it, so a
--    guessed, foreign, or stale task_id is rejected exactly as it would be if it had come from
--    a resolved alias. `ref` stays in the wire shape only because a caller-side audit trail
--    benefits from it; the function never branches on it beyond validating its shape.
--
--    Every field this function does NOT accept — a task's owner, its source, a lock override,
--    a "force" flag, a conflict override, an end time, a duration — is deliberately absent
--    from the parameter list, not merely unread: there is no shape in which the caller could
--    supply one. Every JSON element's keys are also checked exactly, so an unrecognized field
--    (an attempted duration/end/force smuggle) aborts the whole call rather than being ignored.
--
--    Concurrency: `p_base_revision` must equal the plan's current revision or the whole call
--    aborts with 40001 (matching apply_replan()'s existing use of that code for exactly this
--    "computed from a now-stale read" situation) — checked and applied inside one transaction,
--    so nothing can change between the check and the writes. Beyond that coarse check, EVERY
--    referenced task's current row is independently re-verified against the full Phase
--    5.2 AI-movability rule (src/domain/ai-planning/movability.ts `isAiMovable`, reimplemented
--    here in SQL): owned by the caller, on this planning day (a previous day's spillover task,
--    which belongs to a different day, can never be a target — this is what keeps spillover
--    mutation impossible, not a special case), unresolved, unlocked, not `fixed`, not in
--    progress right now. `isAutoMovable()` and apply_replan() play no part here and are
--    untouched. Unlike apply_replan(), this function does not accept or silently skip a
--    genuine no-op: Phase 5.2's validator already excludes a true no-op from `accepted` before
--    a proposal is shown for confirmation, so every element a caller confirms is expected to
--    be a real change, and the new revision is created once, unconditionally, before the loop
--    that applies them — simpler than apply_replan()'s lazy-on-first-change revision, and
--    correct given that difference in what the two callers can submit.
--
--    Every failure — a stale revision, an ineligible task, a resulting conflict, a malformed
--    element — aborts the ENTIRE call via exception; PL/pgSQL has no partial commit within one
--    function invocation, so "no partial mutation" holds by construction, the same way it
--    already does for reschedule_task() and apply_replan().
--
--    Source preservation: the UPDATE this function issues sets only scheduled_start,
--    scheduled_end, unscheduled and schedule_locked. It never sets `source`, so a user-created
--    task stays source = 'user' and a planner task stays source = 'planner' — there is no
--    branch that could convert one into the other.
--
--    Both AI-confirmed operations end a task's move locked (schedule_locked = true), the same
--    outcome reschedule_task() already produces for a real move: a human explicitly approved
--    this placement, so the next automatic "Replan my day" (apply_replan(), planner tasks
--    only) must not silently undo it — exactly the existing purpose of that column.
--
--    Errors (same SQLSTATE vocabulary the existing RPCs already use):
--      42501  not authenticated
--      22023  malformed proposal (bad shape, wrong/missing fields, >20 or 0 changes, a task
--             referenced more than once, an unparseable id/timestamp, an unknown change type)
--      P0002  day/plan not found for the caller, OR a referenced task is not currently
--             eligible (missing, not the caller's, wrong day, resolved, locked, fixed, in
--             progress, or — for `unschedule` — already unscheduled). These are deliberately
--             not distinguished (mirroring reschedule_task()'s and change_task_status()'s
--             existing "missing, not yours, or already resolved" P0002), so a guessed or
--             copied task_id for someone else's row is indistinguishable from one that plain
--             does not exist — no cross-user existence is ever revealed.
--      40001  p_base_revision no longer matches the plan's current revision
--      23P01  the resulting schedule (this day, plus the immediately preceding day's
--             cross-midnight spillover into it) contains a conflict
--
-- Grants: SECURITY DEFINER, `set search_path = ''`, explicit `auth.uid()` checks, no dynamic
-- SQL, EXECUTE to `authenticated` only — the same posture as every Phase 4/4.1 mutation RPC.
-- Nothing about the existing direct-write lockdown changes: tasks, task_history, days, plans
-- and plan_revisions remain SELECT-only for `authenticated`; this function is their one new
-- controlled writer, alongside the four that already exist.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. widen source vocabularies (additive) ─────────────────────────────
alter table public.task_history drop constraint task_history_source_check;
alter table public.task_history
  add constraint task_history_source_check check (source in ('user', 'system', 'ai'));

alter table public.plan_revisions drop constraint plan_revisions_source_check;
alter table public.plan_revisions
  add constraint plan_revisions_source_check check (source in ('system', 'user', 'ai'));

-- ── 2. confirm_ai_proposal ───────────────────────────────────────────────
create function public.confirm_ai_proposal(
  p_day_id        uuid,
  p_base_revision integer,
  p_changes       jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day            public.days;
  v_prev_day_id    uuid;
  v_day_start      timestamptz;
  v_day_end        timestamptz;
  v_plan_id        uuid;
  v_cur_rev        integer;
  v_rev_number     integer;
  v_rev_id         uuid;
  v_change         jsonb;
  v_ref            text;
  v_task_id        uuid;
  v_type           text;
  v_task_ids       uuid[] := '{}';
  v_sorted_ids     uuid[];
  v_old            public.tasks;
  v_new_start      timestamptz;
  v_new_end        timestamptz;
  v_new_unsch      boolean;
  v_conflict_count integer;
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- Keep this cap in sync with MAX_PROPOSED_CHANGES in src/domain/ai-planning/types.ts.
  if p_changes is null or jsonb_typeof(p_changes) <> 'array'
     or jsonb_array_length(p_changes) < 1 or jsonb_array_length(p_changes) > 20 then
    raise exception 'p_changes must be a JSON array of 1 to 20 changes' using errcode = '22023';
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

  select coalesce(max(revision_number), 0) into v_cur_rev
    from public.plan_revisions where plan_id = v_plan_id;
  if v_cur_rev <> p_base_revision then
    raise exception 'the schedule changed since this proposal was generated' using errcode = '40001';
  end if;

  v_day_start := v_day.local_date::timestamp at time zone v_day.timezone;
  v_day_end   := (v_day.local_date + 1)::timestamp at time zone v_day.timezone;

  -- ── pass 1: structural validation of every element, and duplicate-task rejection.
  -- Nothing is read from `tasks` yet — this only rejects proposals that could never be valid,
  -- regardless of current database state.
  for v_change in select * from jsonb_array_elements(p_changes) loop
    if jsonb_typeof(v_change) <> 'object' then
      raise exception 'malformed change' using errcode = '22023';
    end if;

    v_ref := v_change->>'ref';
    if v_ref is null or v_ref !~ '^t[1-9][0-9]{0,3}$' then
      raise exception 'malformed change: invalid ref' using errcode = '22023';
    end if;

    begin
      v_task_id := (v_change->>'task_id')::uuid;
    exception when others then
      raise exception 'malformed change: invalid task_id' using errcode = '22023';
    end;
    if v_task_id is null then
      raise exception 'malformed change: missing task_id' using errcode = '22023';
    end if;

    v_type := v_change->>'type';
    if v_type = 'move' then
      if (v_change - array['ref', 'task_id', 'type', 'new_start']) <> '{}'::jsonb then
        raise exception 'unsupported field in change' using errcode = '22023';
      end if;
      if v_change->>'new_start' is null then
        raise exception 'malformed change: move requires new_start' using errcode = '22023';
      end if;
      begin
        perform (v_change->>'new_start')::timestamptz;
      exception when others then
        raise exception 'malformed change: invalid new_start' using errcode = '22023';
      end;
    elsif v_type = 'unschedule' then
      if (v_change - array['ref', 'task_id', 'type']) <> '{}'::jsonb then
        raise exception 'unsupported field in change' using errcode = '22023';
      end if;
    else
      raise exception 'unsupported change type' using errcode = '22023';
    end if;

    if v_task_id = any(v_task_ids) then
      raise exception 'the same task was referenced more than once' using errcode = '22023';
    end if;
    v_task_ids := v_task_ids || v_task_id;
  end loop;

  -- ── pass 2: lock every targeted row, in a fixed order (sorted by id) regardless of the
  -- proposal's own order, so two confirmations that touch overlapping tasks cannot deadlock.
  -- The revision is created once, up front: every element validated above is expected to
  -- become a real write (see the header note on why this differs from apply_replan()).
  select array_agg(x order by x) into v_sorted_ids from unnest(v_task_ids) t(x);

  select coalesce(max(revision_number), 0) + 1 into v_rev_number
    from public.plan_revisions where plan_id = v_plan_id;
  insert into public.plan_revisions (plan_id, user_id, revision_number, source)
  values (v_plan_id, (select auth.uid()), v_rev_number, 'ai')
  returning id into v_rev_id;

  foreach v_task_id in array v_sorted_ids loop
    select c into v_change
      from jsonb_array_elements(p_changes) c
     where (c->>'task_id')::uuid = v_task_id
     limit 1;
    v_type := v_change->>'type';

    -- The full, CURRENT AI-movability check (src/domain/ai-planning/movability.ts
    -- `isAiMovable`, reimplemented here): owned by the caller, on THIS planning day (excludes
    -- every other day's tasks, including spillover, by construction), unresolved, unlocked,
    -- not fixed, not in progress right now. Phase 5.2's validation result is not consulted —
    -- this is independently re-derived from the row as it exists at this instant.
    select * into v_old
      from public.tasks
     where id = v_task_id
       and user_id = (select auth.uid())
       and day_id = p_day_id
       and status = 'upcoming'
       and not schedule_locked
       and kind <> 'fixed'
       and not (not unscheduled and scheduled_start <= now() and now() < scheduled_end)
       for update;
    if not found then
      raise exception 'a task in this proposal is no longer eligible for an AI-confirmed change'
        using errcode = 'P0002';
    end if;

    if v_type = 'move' then
      v_new_start := (v_change->>'new_start')::timestamptz;
      -- The duration is re-read from the row just locked, never taken from the caller.
      v_new_end   := v_new_start + (v_old.scheduled_end - v_old.scheduled_start);
      v_new_unsch := false;
      if v_new_start < v_day_start or v_new_start >= v_day_end then
        raise exception 'the new start is outside this task''s planning day' using errcode = '22023';
      end if;
      if v_new_end <= now() then
        raise exception 'that time has already passed' using errcode = '22023';
      end if;
    else -- unschedule: times are preserved exactly; only the flag changes.
      if v_old.unscheduled then
        raise exception 'a task in this proposal is no longer eligible for an AI-confirmed change'
          using errcode = 'P0002';
      end if;
      v_new_start := v_old.scheduled_start;
      v_new_end   := v_old.scheduled_end;
      v_new_unsch := true;
    end if;

    update public.tasks
       set scheduled_start = v_new_start,
           scheduled_end = v_new_end,
           unscheduled = v_new_unsch,
           schedule_locked = true
     where id = v_old.id;

    insert into public.task_history (
      task_id, user_id, previous_status, new_status, source, event,
      previous_start, previous_end, new_start, new_end,
      previous_unscheduled, new_unscheduled, revision_id
    )
    values (
      v_old.id, v_old.user_id, 'upcoming', 'upcoming', 'ai', 'rescheduled',
      v_old.scheduled_start, v_old.scheduled_end, v_new_start, v_new_end,
      v_old.unscheduled, v_new_unsch, v_rev_id
    );
  end loop;

  -- ── pass 3: recheck conflicts over the day's now-current schedule, plus the immediately
  -- preceding day's cross-midnight spillover into it (the same two sets
  -- src/server/services/ai-planning.ts feeds into detectScheduleConflicts()). This reads the
  -- rows this same transaction just updated, so it judges the schedule confirmation would
  -- actually produce, not the one Phase 5.2 saw.
  select id into v_prev_day_id
    from public.days
   where user_id = (select auth.uid()) and local_date = v_day.local_date - 1;

  with live as (
    select t.id, t.scheduled_start, t.scheduled_end
      from public.tasks t
     where t.user_id = (select auth.uid())
       and t.status = 'upcoming' and not t.unscheduled and t.scheduled_end > now()
       and (
         t.day_id = p_day_id
         or (v_prev_day_id is not null and t.day_id = v_prev_day_id and t.scheduled_end > v_day_start)
       )
  )
  select count(*) into v_conflict_count
    from live a
    join live b on a.id < b.id
     and a.scheduled_start < b.scheduled_end
     and b.scheduled_start < a.scheduled_end;

  if v_conflict_count > 0 then
    raise exception 'the confirmed changes create a scheduling conflict' using errcode = '23P01';
  end if;

  return v_rev_number;
end;
$$;

revoke execute on function public.confirm_ai_proposal(uuid, integer, jsonb) from public, anon;
grant  execute on function public.confirm_ai_proposal(uuid, integer, jsonb) to authenticated;
