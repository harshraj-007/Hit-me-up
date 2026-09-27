-- ─────────────────────────────────────────────────────────────────────────
-- Phase 6.2: notification reconciliation + atomic due-notification claiming.
--
-- Builds ONLY the database-backed scheduling layer: a materialized, always-re-derivable cache
-- of "what reminder should fire when" (`scheduled_notifications`), and one atomic system RPC
-- that reconciles it against authoritative task state and then claims whatever is due. No Web
-- Push, no service worker, no delivery of any kind — that is Phase 6.3. Phase 6.1's
-- `push_subscriptions` (migration 20260929100000) is untouched by this file; nothing here
-- references it, and nothing here modifies any existing task/AI RPC.
--
-- ── 1. scheduled_notifications ───────────────────────────────────────────
-- A materialized cache, never a second source of truth: everything in it is DERIVED from
-- `tasks` by `reconcile_and_claim_notifications()` below, on every invocation. Nothing here is
-- ever hand-written by application code or by a user — see the grants at the bottom.
--
-- `kind` has exactly one allowed value for Phase 6.2 (`task_reminder`); the column exists so a
-- future kind doesn't need a new table, but no second kind is implemented here (an explicit
-- non-goal).
--
-- `task_scheduled_start_snapshot` is what `fire_at` was last computed from — the same
-- "snapshot the value staleness is detected against" pattern `ai_proposals.base_revision`
-- uses. It is compared to the task's LIVE `scheduled_start` on every reconciliation pass to
-- detect a reschedule; there is no `stale` status, because staleness is corrected in place
-- (the row's own `fire_at`/snapshot are updated), not recorded as a fact about the row.
--
-- `resolved_at` is ONE terminal timestamp, not four (`sent_at`/`failed_at`/`canceled_at`/
-- `expired_at`): every terminal status (`sent`, `failed`, `canceled`, `expired`) is mutually
-- exclusive by definition (a row has exactly one final outcome), so one nullable column
-- captures "when this row left its active life" for all of them — four columns that are always
-- null except exactly one would be the same information with more surface area, contrary to
-- this project's "don't add fields without a real semantic purpose" convention
-- (see `ai_proposals`' own single `confirmed_at`, not `discarded_at`, for the same reasoning).
--
-- Allowed lifecycle (enforced by the RPC below, not by a table trigger — there is exactly one
-- writer, so the invariant lives in the one place that can violate it):
--   scheduled → claimed → (sent | failed)     [sent/failed are Phase 6.3's, not written here]
--   scheduled → canceled                       [reconciliation: task no longer eligible]
--   claimed   → scheduled                      [reconciliation: reschedule sync, or a
--                                                recovered abandoned claim with attempts left]
--   claimed   → expired                        [an abandoned claim with no attempts left]
create table public.scheduled_notifications (
  id                             uuid primary key default gen_random_uuid(),
  user_id                        uuid not null references auth.users (id) on delete cascade,
  task_id                        uuid not null references public.tasks (id) on delete cascade,
  day_id                         uuid not null references public.days (id) on delete cascade,
  kind                           text not null default 'task_reminder',
  fire_at                        timestamptz not null,
  task_scheduled_start_snapshot  timestamptz not null,
  status                         text not null default 'scheduled',
  claimed_at                     timestamptz,
  attempt_count                  integer not null default 0,
  resolved_at                    timestamptz,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  constraint scheduled_notifications_kind_check check (kind in ('task_reminder')),
  constraint scheduled_notifications_status_check
    check (status in ('scheduled', 'claimed', 'sent', 'failed', 'canceled', 'expired')),
  constraint scheduled_notifications_attempt_count_nonneg check (attempt_count >= 0),
  -- claimed_at is set if and only if the row is currently claimed.
  constraint scheduled_notifications_claimed_at_matches_status check (
    (status = 'claimed' and claimed_at is not null)
    or (status <> 'claimed' and claimed_at is null)
  ),
  -- resolved_at is set if and only if the row has reached a terminal outcome.
  constraint scheduled_notifications_resolved_at_matches_status check (
    (status in ('sent', 'failed', 'canceled', 'expired') and resolved_at is not null)
    or (status in ('scheduled', 'claimed') and resolved_at is null)
  )
);

create index scheduled_notifications_user_id_idx on public.scheduled_notifications (user_id);
create index scheduled_notifications_task_id_idx on public.scheduled_notifications (task_id);
-- The claim step's own access pattern: due, still-scheduled rows, oldest first.
create index scheduled_notifications_claimable_idx
  on public.scheduled_notifications (fire_at)
  where status = 'scheduled';

-- At most one ACTIVE (claimable-or-in-flight) task_reminder per task, enforced in the
-- database, not application code — the same pattern `ai_proposals_one_pending_per_day` uses.
-- Deliberately scoped to `scheduled`/`claimed` only: a terminal row (sent/failed/canceled/
-- expired) is history, not a live claim on the identity, so it must NEVER block a fresh one
-- from being created for the same task later (e.g. after a task is un-cancelled by nothing —
-- there is no such operation today — or, more realistically, after the active row a task
-- currently owns eventually resolves and, if the task is later rescheduled again, a new one is
-- created for it).
create unique index scheduled_notifications_one_active_per_task_kind
  on public.scheduled_notifications (task_id, kind)
  where status in ('scheduled', 'claimed');

alter table public.scheduled_notifications enable row level security;

-- Owner-scoped read access, for a future UI (Phase 6.2 itself has none) — see push_subscriptions
-- for the identical posture. No insert/update/delete policy: every write goes through the one
-- SECURITY DEFINER RPC below, callable only by service_role (not even `authenticated`) — an
-- ordinary user, no matter how they craft a request, cannot create, claim, or resolve a
-- notification of their own or anyone else's.
create policy "scheduled_notifications: select own"
  on public.scheduled_notifications for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.scheduled_notifications from anon, authenticated, service_role;
grant select on public.scheduled_notifications to authenticated;
-- service_role bypasses RLS by its nature, but table-level grants are still checked; without
-- this it could not even read its own claimed rows back via a plain query (it only needs to,
-- and only ever will, go through the RPC below — this SELECT grant is not currently exercised
-- by any code path, kept minimal and symmetrical with `authenticated`'s).
grant select on public.scheduled_notifications to service_role;

-- ── 2. reconcile_and_claim_notifications ─────────────────────────────────
-- The ONLY way this table is ever written. A system-only RPC: no auth.uid() (there is no user
-- session on the cron path) — instead it requires the JWT's own `role` claim to be
-- 'service_role', checked explicitly in the function body (defense in depth alongside the
-- EXECUTE grant below, which is the primary boundary: neither `anon` nor `authenticated` can
-- even call this function at all). Reconciliation and claiming happen in ONE transaction (one
-- PL/pgSQL call), in this exact order, so a notification reconciliation has just invalidated
-- this cycle can never be claimed by the same cycle:
--
--   1. Recover abandoned claims (lease expiry)      claimed → scheduled | expired
--   2. Sync active rows to their task's CURRENT schedule (reschedule)   scheduled (in place)
--   3. Cancel active rows whose task is no longer upcoming              scheduled → canceled
--   4. Create a fresh row for any in-horizon upcoming task with none    (new) → scheduled
--   5. Claim whatever is due, right now, with FOR UPDATE SKIP LOCKED    scheduled → claimed
--
-- Reconciliation derives EVERYTHING from `public.tasks`; it never writes to `tasks` or
-- `task_history`, and never introduces a second notion of what a task's schedule is — a
-- notification's `fire_at` is always `scheduled_start - 10 minutes`, recomputed from the live
-- column, in plain UTC/instant arithmetic (tasks already store absolute `timestamptz`
-- instants — see PROJECT_ARCHITECTURE.md's Phase 4.1 timezone strategy). No new timezone
-- conversion exists anywhere in this file.
--
-- Constants (chosen for Phase 6.2, not read from a config table — see PROJECT_ARCHITECTURE.md
-- for the reasoning): a 10-minute reminder offset, a 24-hour scheduling horizon, a 5-minute
-- claim lease, and a 3-attempt cap on lease recovery before a stuck claim is given up on
-- (`expired`) rather than retried forever.
create function public.reconcile_and_claim_notifications()
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
     );

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

revoke execute on function public.reconcile_and_claim_notifications() from public, anon, authenticated;
grant  execute on function public.reconcile_and_claim_notifications() to service_role;
