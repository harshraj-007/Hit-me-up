-- ─────────────────────────────────────────────────────────────────────────
-- Phase 3: initial persistent schema for the Personal AI Daily Dashboard.
--
-- Scope: profiles, days, briefings, tasks, task_history, plans, plan_revisions.
-- No AI-specific columns. See PROJECT_ARCHITECTURE.md §"Phase 3" for the full
-- design rationale (task status model, timezone strategy, plan/revision model).
--
-- Every table is owned by exactly one auth.users row (`user_id`), RLS is
-- enabled on all of them, and every policy is scoped to `(select auth.uid())`.
-- Nothing in this file uses SECURITY DEFINER; the two RPC functions run as
-- SECURITY INVOKER, so they execute with the *caller's* privileges and are
-- still subject to RLS — they exist for atomicity (task + history together),
-- not to bypass row ownership.
-- ─────────────────────────────────────────────────────────────────────────

-- ── shared trigger: keep `updated_at` honest without trusting the client ──
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── profiles ────────────────────────────────────────────────────────────
-- Minimal, app-local extension of auth.users. It exists only to hold
-- `timezone`, which Supabase Auth has no concept of and the domain needs to
-- compute "today" correctly (see PROJECT_ARCHITECTURE.md). It never
-- duplicates credentials or identity — `id` *is* the auth.users id.
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  timezone   text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_timezone_not_blank check (btrim(timezone) <> '')
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

create policy "profiles: select own"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "profiles: insert own"
  on public.profiles for insert
  to authenticated
  with check ((select auth.uid()) = id);

create policy "profiles: update own"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- ── days ────────────────────────────────────────────────────────────────
-- One row per (user, calendar date). `local_date` is computed by the
-- application from the user's profile timezone at the moment "Today" is
-- opened — it is the day's stable identity, not a timestamp. The unique
-- constraint (not just an application check) is what makes day
-- initialization idempotent under concurrent requests.
create table public.days (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  local_date date not null,
  timezone   text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint days_user_date_unique unique (user_id, local_date)
);

create index days_user_id_idx on public.days (user_id);

create trigger days_set_updated_at
  before update on public.days
  for each row execute function public.set_updated_at();

alter table public.days enable row level security;

create policy "days: select own"
  on public.days for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "days: insert own"
  on public.days for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "days: update own"
  on public.days for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ── briefings ───────────────────────────────────────────────────────────
-- Append-only: every save is a new row rather than an in-place edit, so the
-- user's original wording stays auditable (Phase 3 spec §7). The "current"
-- briefing for a day is simply the most recent row.
create table public.briefings (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  day_id     uuid not null references public.days (id) on delete cascade,
  raw_text   text not null,
  created_at timestamptz not null default now(),
  constraint briefings_raw_text_not_blank check (btrim(raw_text) <> ''),
  constraint briefings_raw_text_length check (char_length(raw_text) <= 4000)
);

create index briefings_day_created_idx on public.briefings (day_id, created_at desc);

alter table public.briefings enable row level security;

create policy "briefings: select own"
  on public.briefings for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "briefings: insert own"
  on public.briefings for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- ── tasks ───────────────────────────────────────────────────────────────
-- Persisted status is intentionally a 4-way enum (upcoming/completed/
-- skipped/late), NOT five. "current" is never stored: it is derived at read
-- time from (status = 'upcoming' AND now within [scheduled_start,
-- scheduled_end]). Storing "current" would need a background job to expire
-- it again once the window passed, and scheduled jobs are explicitly out of
-- this phase's scope — see PROJECT_ARCHITECTURE.md for the full rationale.
--
-- completed/skipped/late are terminal ("resolved"): once a task reaches one
-- of them, application code and the change_task_status() RPC below both
-- refuse any further transition, so replanning (a later phase) can never
-- silently move or revert resolved work.
create table public.tasks (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  day_id           uuid not null references public.days (id) on delete cascade,
  title            text not null,
  notes            text,
  status           text not null default 'upcoming',
  priority         text not null default 'medium',
  kind             text not null default 'flexible',
  source           text not null default 'user',
  scheduled_start  timestamptz not null,
  scheduled_end    timestamptz not null,
  due_at           timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tasks_title_not_blank check (btrim(title) <> ''),
  constraint tasks_title_length check (char_length(title) <= 200),
  constraint tasks_status_check check (status in ('upcoming', 'completed', 'skipped', 'late')),
  constraint tasks_priority_check check (priority in ('high', 'medium', 'low')),
  constraint tasks_kind_check check (kind in ('fixed', 'flexible', 'deadline', 'optional', 'recurring')),
  constraint tasks_source_check check (source in ('user', 'planner')),
  constraint tasks_time_order check (scheduled_end > scheduled_start),
  -- Resolved tasks must record when they were resolved; unresolved tasks must not.
  constraint tasks_completed_at_matches_status check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  )
);

create index tasks_user_id_idx on public.tasks (user_id);
create index tasks_day_start_idx on public.tasks (day_id, scheduled_start);

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

alter table public.tasks enable row level security;

create policy "tasks: select own"
  on public.tasks for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "tasks: insert own"
  on public.tasks for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "tasks: update own"
  on public.tasks for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- No delete policy: tasks are not deletable in this phase (nothing in the
-- product needs it yet, and keeping them append/update-only keeps history
-- trustworthy). Add one deliberately if a later phase needs it.

-- ── task_history ────────────────────────────────────────────────────────
-- Append-only audit trail of status changes. `previous_status` is null for
-- the row recorded at task creation. `user_id` is denormalized from the
-- parent task purely so RLS here is a direct column check rather than a
-- subquery join on every read.
create table public.task_history (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid not null references public.tasks (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  previous_status text,
  new_status      text not null,
  source          text not null default 'user',
  changed_at      timestamptz not null default now(),
  constraint task_history_previous_status_check
    check (previous_status is null or previous_status in ('upcoming', 'completed', 'skipped', 'late')),
  constraint task_history_new_status_check
    check (new_status in ('upcoming', 'completed', 'skipped', 'late')),
  constraint task_history_source_check check (source in ('user', 'system'))
);

create index task_history_task_changed_idx on public.task_history (task_id, changed_at);

alter table public.task_history enable row level security;

create policy "task_history: select own"
  on public.task_history for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "task_history: insert own"
  on public.task_history for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- ── plans / plan_revisions ──────────────────────────────────────────────
-- A `plan` is the planning thread for one day (at most one per day, hence
-- the unique constraint on day_id — mirroring the days.user_id/local_date
-- invariant one level down). A `plan_revision` is a version marker within
-- that thread: Phase 3 creates exactly one (revision 1, source 'system')
-- when a day is first initialized, establishing the Day -> Plan ->
-- Revisions relationship that a later AI-replanning phase will extend by
-- inserting revision 2, 3, ... rather than mutating revision 1. Revisions
-- deliberately hold no task snapshot yet: nothing in this phase produces or
-- consumes one, and speculatively designing that shape now would be
-- guessing at a future phase's needs.
create table public.plans (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  day_id     uuid not null references public.days (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint plans_day_unique unique (day_id)
);

alter table public.plans enable row level security;

create policy "plans: select own"
  on public.plans for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "plans: insert own"
  on public.plans for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create table public.plan_revisions (
  id              uuid primary key default gen_random_uuid(),
  plan_id         uuid not null references public.plans (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  revision_number integer not null,
  source          text not null default 'system',
  created_at      timestamptz not null default now(),
  constraint plan_revisions_number_positive check (revision_number > 0),
  constraint plan_revisions_number_unique unique (plan_id, revision_number),
  constraint plan_revisions_source_check check (source in ('system', 'user'))
);

create index plan_revisions_plan_idx on public.plan_revisions (plan_id, revision_number desc);

alter table public.plan_revisions enable row level security;

create policy "plan_revisions: select own"
  on public.plan_revisions for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "plan_revisions: insert own"
  on public.plan_revisions for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- ── RPC: create_task_with_history ──────────────────────────────────────
-- Inserts a task and its "created" history row atomically. SECURITY
-- INVOKER (the default — stated explicitly for clarity): it runs as the
-- calling user and is fully subject to the RLS policies above, so it grants
-- no privilege the caller didn't already have via direct table access.
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
security invoker
set search_path = ''
as $$
declare
  v_task public.tasks;
begin
  -- Application code always resolves p_day_id server-side (never from a client-supplied
  -- value) before calling this, so this can't normally fail — it's a defensive check
  -- against a day_id that doesn't belong to the caller, kept here for any future caller of
  -- this RPC that might be less careful.
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

  insert into public.task_history (task_id, user_id, previous_status, new_status, source)
  values (v_task.id, v_task.user_id, null, v_task.status, 'user');

  return v_task;
end;
$$;

revoke all on function public.create_task_with_history from public;
grant execute on function public.create_task_with_history to authenticated;

-- ── RPC: change_task_status ─────────────────────────────────────────────
-- Updates a task's status and appends a history row atomically, and is the
-- single place the "resolved tasks are terminal" rule is enforced at the
-- database layer (the application/domain layer enforces it too, before
-- this is ever called — this is defense in depth, not the only check).
-- The UPDATE's WHERE clause only matches rows still 'upcoming', so calling
-- this against an already-resolved task raises "task not upcoming" and
-- changes nothing.
create or replace function public.change_task_status(
  p_task_id   uuid,
  p_new_status text
)
returns public.tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_task public.tasks;
begin
  if p_new_status not in ('completed', 'skipped', 'late') then
    raise exception 'invalid target status: %', p_new_status
      using errcode = '22023'; -- invalid_parameter_value
  end if;

  update public.tasks
     set status = p_new_status,
         completed_at = case when p_new_status = 'completed' then now() else null end
   where id = p_task_id
     and user_id = (select auth.uid())
     and status = 'upcoming'
  returning * into v_task;

  if not found then
    raise exception 'task % is not in a state that can change (missing, not yours, or already resolved)', p_task_id
      using errcode = 'P0002'; -- no_data_found
  end if;

  insert into public.task_history (task_id, user_id, previous_status, new_status, source)
  values (v_task.id, v_task.user_id, 'upcoming', v_task.status, 'user');

  return v_task;
end;
$$;

revoke all on function public.change_task_status from public;
grant execute on function public.change_task_status to authenticated;
