-- ─────────────────────────────────────────────────────────────────────────
-- Phase 8: plan the day from the saved briefing — NEW tasks through the existing
-- create_ai_proposal → confirm_ai_proposal pipeline.
--
-- ONE additive migration. No earlier migration is edited; every function below is replaced
-- with `create or replace` (same signature, so its grants — including Phase 6's revocation from
-- service_role — carry over untouched) except create_ai_proposal, whose signature gains one
-- defaulted parameter and is therefore dropped and recreated with its grants restated.
--
-- The model still holds no privilege. It can only PROPOSE; Phase 5.0 validation (now including
-- creations) judges the proposal, the user explicitly confirms one stored proposal by id, and
-- this migration is the only place a created task can come into existence — atomically, with
-- history and exactly one AI plan revision, and with every rule re-derived in SQL from the
-- row data, never trusting what validation said earlier.
--
-- 1. ai_proposals.briefing_id — which saved briefing a proposal was planned from (optional;
--    NULL for the ordinary "Ask AI" flow). It is also the structural switch for creation: a
--    stored proposal may contain `create` changes ONLY if it is linked to a briefing the
--    caller owns for that same day (create_ai_proposal enforces that), and only such a
--    proposal's confirmation is allowed to create tasks (confirm_ai_proposal_by_id passes
--    p_allow_create from it).
--
-- 2. ai_apply_changes_internal(day, base_revision, changes, allow_create) — the Phase 5.3 body
--    of confirm_ai_proposal(), moved here VERBATIM in behaviour for `move` and `unschedule`,
--    plus the `create` pass. Nothing can EXECUTE it directly: it is revoked from PUBLIC, anon,
--    authenticated and service_role, and is reachable only through the two SECURITY DEFINER
--    wrappers below (which run as the owner). Two deliberate additions apply to ALL changes:
--      * the day's `plans` row is locked FOR NO KEY UPDATE first, so two confirmations for one
--        day serialize (the second then fails the stale-revision check with 40001 instead of
--        colliding on the revision number). NO KEY UPDATE, not UPDATE, because it must not
--        conflict with the FOR KEY SHARE lock a concurrent reschedule_task() / apply_replan()
--        takes on the plan when it inserts a revision — that would invite a lock-order deadlock;
--      * the revision is still created exactly ONCE per call, so a confirmation that creates
--        tasks, moves tasks, or both yields exactly one `ai` revision.
--
--    A `create` element is `{ref, type:'create', title, start, duration_minutes, priority, kind}`:
--      * keys are checked EXACTLY (an `end`, `notes`, `source`, `task_id`, `status`, `user_id`,
--        `due_at`, … aborts the whole call), `ref` is the server-assigned `n1`, `n2`, … shape;
--      * title: plain text, collapsed and trimmed, 1–100 characters, no control/invisible
--        characters, no angle brackets, no links — the same rule as the TypeScript validator;
--      * duration_minutes: an integer, 5 … 1440 (the existing 24-hour task limit); the END is
--        derived here as start + duration — there is no end field to supply;
--      * priority ∈ high|medium|low; kind ∈ flexible|deadline|optional|fixed (never recurring);
--      * the whole window must sit inside the day's frozen-timezone bounds (start ≥ day start,
--        end ≤ day end) and must not already be over (end > now(), the same "that time has
--        already passed" rule a move gets — a task a minute into running is not refused just
--        because the review took a minute; the generating validator is stricter and requires a
--        start no earlier than the moment of generation);
--      * the title must not equal (case-insensitively, whitespace-collapsed) any existing task
--        on that day, nor another create in the same proposal;
--      * the created row is ALWAYS source 'planner', status 'upcoming', unlocked, scheduled,
--        no notes, no due date — none of those is expressible in the input;
--      * history: one `created` row per task, source 'ai', linked to the new revision.
--    Overlap is the existing pass 3: after every write the day's live schedule (plus the
--    previous day's cross-midnight spillover) is re-read inside the same transaction, so a
--    created task overlapping an existing one, or another created one, raises 23P01 and the
--    ENTIRE call — every move and every creation — rolls back. All-or-nothing, by construction.
--
--    Errors are the Phase 5.3 vocabulary, unchanged: 42501 not authenticated · 22023 malformed
--    or invalid change · P0002 day/plan/task not found or not eligible (never distinguished) ·
--    40001 stale base revision · 23P01 resulting conflict.
--
-- 3. confirm_ai_proposal(day, base_revision, changes) — same signature and grants, now a thin
--    wrapper that calls the internal function with allow_create = false. The lower-level
--    primitive therefore still cannot create anything: a direct caller gets 22023
--    ("unsupported change type") for a `create`, exactly as before this phase.
--
-- 4. confirm_ai_proposal_by_id(id) — same signature and grants; locking, ownership, replay
--    and `valid`-only gates unchanged; calls the internal function with
--    allow_create = (the stored proposal has a briefing_id).
--
-- 5. create_ai_proposal(..., p_briefing_id default null) — see the ownership checks inside.
--
-- Everything stays SECURITY DEFINER, `set search_path = ''`, authenticated-only (service_role
-- explicitly revoked on every new/recreated object — Supabase grants it EXECUTE by default),
-- no dynamic SQL, no direct table writes from any client.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. link a proposal to the briefing it was planned from ────────────────
alter table public.ai_proposals
  add column briefing_id uuid references public.briefings (id) on delete set null;

-- ── 2. the shared apply function (internal) ───────────────────────────────
create function public.ai_apply_changes_internal(
  p_day_id        uuid,
  p_base_revision integer,
  p_changes       jsonb,
  p_allow_create  boolean
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
  -- create
  v_title          text;
  v_title_key      text;
  v_title_keys     text[] := '{}';
  v_dur_text       text;
  v_dur            numeric;
  v_start_text     text;
  v_new_task       public.tasks;
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

  -- Serializes confirmations for one day (see the header: NO KEY UPDATE on purpose).
  select id into v_plan_id
    from public.plans
   where day_id = p_day_id and user_id = (select auth.uid())
     for no key update;
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

  -- ── pass 1: structural validation of every element, and duplicate rejection.
  -- Nothing is read from `tasks` except the day's titles for the duplicate-title rule; this
  -- rejects proposals that could never be valid regardless of current database state.
  for v_change in select * from jsonb_array_elements(p_changes) loop
    if jsonb_typeof(v_change) <> 'object' then
      raise exception 'malformed change' using errcode = '22023';
    end if;

    v_ref  := v_change->>'ref';
    v_type := v_change->>'type';

    if v_type = 'create' then
      if not p_allow_create then
        raise exception 'unsupported change type' using errcode = '22023';
      end if;
      if (v_change - array['ref', 'type', 'title', 'start', 'duration_minutes', 'priority', 'kind'])
           <> '{}'::jsonb then
        raise exception 'unsupported field in change' using errcode = '22023';
      end if;
      if v_ref is null or v_ref !~ '^n[1-9][0-9]{0,3}$' then
        raise exception 'malformed change: invalid ref' using errcode = '22023';
      end if;

      if jsonb_typeof(v_change->'title') is distinct from 'string' then
        raise exception 'malformed change: title must be text' using errcode = '22023';
      end if;
      v_title := v_change->>'title';
      -- Plain text only (mirrors checkNewTaskTitle): no control / invisible characters, no
      -- markup brackets, no links. Checked BEFORE whitespace is collapsed, so a line break is
      -- refused rather than flattened.
      if v_title ~ '[\u0000-\u001f\u007f-\u009f​-‏ -‮⁠-⁤﻿<>]'
         or v_title ~* '(://|(^|[^a-z])(https?|ftp|javascript|data|mailto):|www\.|\]\()' then
        raise exception 'malformed change: title is not plain text' using errcode = '22023';
      end if;
      v_title := btrim(regexp_replace(v_title, '\s+', ' ', 'g'));
      if v_title = '' or char_length(v_title) > 100 then
        raise exception 'malformed change: title length' using errcode = '22023';
      end if;
      v_title_key := lower(v_title);
      if v_title_key = any(v_title_keys) then
        raise exception 'two new tasks share a title' using errcode = '22023';
      end if;
      v_title_keys := v_title_keys || v_title_key;
      if exists (
        select 1 from public.tasks t
         where t.day_id = p_day_id and t.user_id = (select auth.uid())
           and lower(btrim(regexp_replace(t.title, '\s+', ' ', 'g'))) = v_title_key
      ) then
        raise exception 'a task with that title already exists on this day' using errcode = '22023';
      end if;

      if jsonb_typeof(v_change->'duration_minutes') is distinct from 'number' then
        raise exception 'malformed change: duration_minutes' using errcode = '22023';
      end if;
      v_dur := (v_change->>'duration_minutes')::numeric;
      if v_dur <> trunc(v_dur) or v_dur < 5 or v_dur > 1440 then
        raise exception 'malformed change: duration_minutes out of range' using errcode = '22023';
      end if;

      if (v_change->>'priority') is null or (v_change->>'priority') not in ('high', 'medium', 'low') then
        raise exception 'malformed change: priority' using errcode = '22023';
      end if;
      if (v_change->>'kind') is null
         or (v_change->>'kind') not in ('flexible', 'deadline', 'optional', 'fixed') then
        raise exception 'malformed change: kind' using errcode = '22023';
      end if;

      v_start_text := v_change->>'start';
      if v_start_text is null then
        raise exception 'malformed change: create requires start' using errcode = '22023';
      end if;
      begin
        perform v_start_text::timestamptz;
      exception when others then
        raise exception 'malformed change: invalid start' using errcode = '22023';
      end;
      continue;
    end if;

    -- move / unschedule (Phase 5.3, unchanged)
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

  -- ── pass 2: the revision (once, up front), then every targeted row locked in a fixed order
  -- (sorted by id) regardless of the proposal's own order, so two confirmations that touch
  -- overlapping tasks cannot deadlock.
  select array_agg(x order by x) into v_sorted_ids from unnest(v_task_ids) t(x);
  v_sorted_ids := coalesce(v_sorted_ids, '{}');

  select coalesce(max(revision_number), 0) + 1 into v_rev_number
    from public.plan_revisions where plan_id = v_plan_id;
  insert into public.plan_revisions (plan_id, user_id, revision_number, source)
  values (v_plan_id, (select auth.uid()), v_rev_number, 'ai')
  returning id into v_rev_id;

  foreach v_task_id in array v_sorted_ids loop
    select c into v_change
      from jsonb_array_elements(p_changes) c
     where c->>'task_id' = v_task_id::text
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

  -- ── pass 2b: create the new tasks. Everything is re-derived from the validated JSON; the
  -- END is computed here, and `source`/`status`/`notes`/`due_at`/lock flags are not inputs.
  for v_change in
    select c from jsonb_array_elements(p_changes) with ordinality as e(c, n)
     where c->>'type' = 'create' order by n
  loop
    v_new_start := (v_change->>'start')::timestamptz;
    v_new_end   := v_new_start + ((v_change->>'duration_minutes')::integer * interval '1 minute');
    if v_new_start < v_day_start or v_new_end > v_day_end then
      raise exception 'a new task must start and finish inside the planning day' using errcode = '22023';
    end if;
    if v_new_end <= now() then
      raise exception 'that time has already passed' using errcode = '22023';
    end if;

    insert into public.tasks (
      user_id, day_id, title, notes, priority, kind, source,
      scheduled_start, scheduled_end, due_at
    )
    values (
      (select auth.uid()), p_day_id,
      btrim(regexp_replace(v_change->>'title', '\s+', ' ', 'g')),
      null, v_change->>'priority', v_change->>'kind', 'planner',
      v_new_start, v_new_end, null
    )
    returning * into v_new_task;

    insert into public.task_history (
      task_id, user_id, previous_status, new_status, source, event,
      new_start, new_end, new_unscheduled, revision_id
    )
    values (
      v_new_task.id, v_new_task.user_id, null, v_new_task.status, 'ai', 'created',
      v_new_start, v_new_end, false, v_rev_id
    );
  end loop;

  -- ── pass 3: recheck conflicts over the day's now-current schedule, plus the immediately
  -- preceding day's cross-midnight spillover into it (the same two sets
  -- src/server/services/ai-planning.ts feeds into detectScheduleConflicts()). This reads the
  -- rows this same transaction just wrote — moved AND created — so it judges the schedule
  -- confirmation would actually produce, not the one Phase 5.2 saw. A new task overlapping an
  -- existing task, or another new task, fails here and rolls everything back.
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

-- Not callable by anyone: only the two SECURITY DEFINER wrappers below reach it.
revoke execute on function public.ai_apply_changes_internal(uuid, integer, jsonb, boolean)
  from public, anon, authenticated, service_role;

-- ── 3. confirm_ai_proposal: same signature, creations NOT allowed ─────────
create or replace function public.confirm_ai_proposal(
  p_day_id        uuid,
  p_base_revision integer,
  p_changes       jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  return public.ai_apply_changes_internal(p_day_id, p_base_revision, p_changes, false);
end;
$$;

-- ── 4. confirm_ai_proposal_by_id: creations allowed only for a briefing proposal ──
create or replace function public.confirm_ai_proposal_by_id(
  p_proposal_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal   public.ai_proposals;
  v_new_rev    integer;
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select * into v_proposal
    from public.ai_proposals
   where id = p_proposal_id
     and user_id = (select auth.uid())
     and status = 'generated'
     for update;
  if not found then
    raise exception 'proposal % is not available to confirm (missing, not yours, or already resolved)', p_proposal_id
      using errcode = 'P0002';
  end if;
  -- Only a fully valid proposal may ever be confirmed (Phase 5.0's own rule), enforced here in
  -- SQL, not merely by a disabled Apply button.
  if v_proposal.validation_status <> 'valid' then
    raise exception 'proposal % is not valid and cannot be confirmed', p_proposal_id
      using errcode = 'P0002';
  end if;

  v_new_rev := public.ai_apply_changes_internal(
    v_proposal.day_id, v_proposal.base_revision, v_proposal.changes,
    v_proposal.briefing_id is not null
  );

  update public.ai_proposals
     set status = 'confirmed',
         confirmed_at = now(),
         applied_revision_number = v_new_rev
   where id = v_proposal.id;

  return v_new_rev;
end;
$$;

-- ── 5. create_ai_proposal: + p_briefing_id ────────────────────────────────
drop function public.create_ai_proposal(uuid, integer, text, text, text, jsonb, jsonb, jsonb, jsonb, text);

create function public.create_ai_proposal(
  p_day_id            uuid,
  p_base_revision     integer,
  p_source            text,
  p_transcript_text   text,
  p_understood        text,
  p_unresolved        jsonb,
  p_changes           jsonb,
  p_rejected          jsonb,
  p_conflicts_after   jsonb,
  p_validation_status text,
  p_briefing_id       uuid default null
)
returns public.ai_proposals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.ai_proposals;
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.days where id = p_day_id and user_id = (select auth.uid())
  ) then
    raise exception 'day % not found for current user', p_day_id using errcode = 'P0002';
  end if;

  -- A proposal planned from a briefing must name a briefing the caller owns, saved for THIS day.
  if p_briefing_id is not null and not exists (
    select 1 from public.briefings
     where id = p_briefing_id and user_id = (select auth.uid()) and day_id = p_day_id
  ) then
    raise exception 'briefing not found for this day' using errcode = 'P0002';
  end if;

  if p_source not in ('typed', 'voice') then
    raise exception 'invalid source' using errcode = '22023';
  end if;
  if p_validation_status not in ('valid', 'partially_valid', 'invalid') then
    raise exception 'invalid validation_status' using errcode = '22023';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 20 then
    raise exception 'p_changes must be a JSON array of at most 20 changes' using errcode = '22023';
  end if;
  -- New tasks exist only in a proposal planned from a briefing.
  if p_briefing_id is null and exists (
    select 1 from jsonb_array_elements(p_changes) c where c->>'type' = 'create'
  ) then
    raise exception 'only a proposal planned from a briefing may create tasks' using errcode = '22023';
  end if;
  if p_unresolved is null or jsonb_typeof(p_unresolved) <> 'array' then
    raise exception 'p_unresolved must be a JSON array' using errcode = '22023';
  end if;
  if p_rejected is null or jsonb_typeof(p_rejected) <> 'array' then
    raise exception 'p_rejected must be a JSON array' using errcode = '22023';
  end if;
  if p_conflicts_after is null or jsonb_typeof(p_conflicts_after) <> 'array' then
    raise exception 'p_conflicts_after must be a JSON array' using errcode = '22023';
  end if;
  if p_transcript_text is null or btrim(p_transcript_text) = '' then
    raise exception 'transcript text is required' using errcode = '22023';
  end if;

  -- Supersede any earlier pending proposal for this day before inserting the new one.
  update public.ai_proposals
     set status = 'discarded'
   where day_id = p_day_id
     and user_id = (select auth.uid())
     and status = 'generated';

  insert into public.ai_proposals (
    user_id, day_id, base_revision, source, transcript_text,
    understood, unresolved, changes, rejected, conflicts_after, validation_status, briefing_id
  )
  values (
    (select auth.uid()), p_day_id, p_base_revision, p_source, p_transcript_text,
    p_understood, p_unresolved, p_changes, p_rejected, p_conflicts_after, p_validation_status,
    p_briefing_id
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.create_ai_proposal(
  uuid, integer, text, text, text, jsonb, jsonb, jsonb, jsonb, text, uuid
) from public, anon, service_role;
grant execute on function public.create_ai_proposal(
  uuid, integer, text, text, text, jsonb, jsonb, jsonb, jsonb, text, uuid
) to authenticated;
