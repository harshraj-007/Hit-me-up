-- ─────────────────────────────────────────────────────────────────────────
-- Phase 5.5: persistent AI proposals + resumable, replay-safe confirmation.
--
-- Phase 5.2 generated a proposal and validated it in memory only; Phase 5.3 could confirm it
-- only in the same request. This migration lets a validated proposal survive a refresh or
-- navigation, and adds the replay-safe confirmation path for it. `confirm_ai_proposal()`
-- (Phase 5.3) is NOT modified by this file — its entire existing test suite and scratch-SQL
-- verification remain valid evidence for the code this migration composes with, not duplicates.
--
-- ── 1. ai_proposals ──────────────────────────────────────────────────────
-- A proposal is a historical snapshot — "the AI proposed THIS against revision X" — never a
-- live view of current state. Its substantive columns (day_id, base_revision, source,
-- transcript_text, changes, understood, unresolved, validation_status) are therefore never
-- updated after insert; only `status`/`confirmed_at`/`applied_revision_number` change, and only
-- through the two RPCs below, never a direct UPDATE (see the grants at the bottom).
--
-- `changes` is the SAME wire shape confirm_ai_proposal() already accepts for p_changes — an
-- array of { ref, task_id, type, new_start? } — so confirm_ai_proposal_by_id() below can pass
-- it straight through with no reshaping. It is validated at generation time by the application
-- (Phase 5.0's validateProposal) before it is ever written here, and independently
-- RE-validated by confirm_ai_proposal() at confirmation time regardless — this table is never
-- trusted as authorization, only as "what was shown to the user".
--
-- `status = 'generated'` is the only status a NEW row may have. Only one row per (user_id,
-- day_id) may be 'generated' at a time — enforced by a partial unique index, not application
-- code — so a fresh generation must supersede (discard) any earlier pending one atomically;
-- see create_ai_proposal() below.
--
-- No `stale` status exists: whether a proposal is stale is a live comparison between
-- `base_revision` and the day's CURRENT plan revision, computed at read time (see
-- repositories/ai-proposals.ts). Storing it would need a background job to keep honest, which
-- this project does not have and Phase 5.5 does not introduce.
create table public.ai_proposals (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users (id) on delete cascade,
  day_id                uuid not null references public.days (id) on delete cascade,
  base_revision         integer not null,
  source                text not null,
  -- The approved transcript/typed text this proposal was generated from. Private user data —
  -- protected the same way the row itself is (owner-only SELECT), and named so the existing
  -- Phase 5.4 log-redaction rule (which matches any key containing "transcript") already masks
  -- it with no redaction-code change.
  transcript_text       text not null,
  understood            text not null,
  unresolved            jsonb not null default '[]'::jsonb,
  -- The Phase 5.3 confirm wire shape (ref/task_id/type/new_start) for ACCEPTED changes only —
  -- exactly what confirm_ai_proposal_by_id() reads and forwards unmodified. `rejected` and
  -- `conflicts_after` are display-only (the resumed review UI's "why wasn't this applied"),
  -- never read by any confirmation path — the SQL re-validation at confirm time is what
  -- actually decides eligibility, not what is stored here.
  changes               jsonb not null,
  rejected              jsonb not null default '[]'::jsonb,
  conflicts_after       jsonb not null default '[]'::jsonb,
  -- Display-only summary of the Phase 5.0 ValidationResult this proposal was generated with;
  -- purely informational — confirmation re-derives everything from current state regardless.
  validation_status     text not null,
  status                text not null default 'generated',
  created_at            timestamptz not null default now(),
  confirmed_at          timestamptz,
  applied_revision_number integer,
  constraint ai_proposals_source_check check (source in ('typed', 'voice')),
  constraint ai_proposals_validation_status_check
    check (validation_status in ('valid', 'partially_valid', 'invalid')),
  constraint ai_proposals_status_check check (status in ('generated', 'confirmed', 'discarded')),
  constraint ai_proposals_base_revision_positive check (base_revision >= 0),
  constraint ai_proposals_transcript_not_blank check (btrim(transcript_text) <> ''),
  constraint ai_proposals_transcript_length check (char_length(transcript_text) <= 1000),
  -- 0 accepted changes is a real, storable outcome (a partially_valid/invalid proposal may
  -- have nothing accepted at all) — it is simply never confirmable; see
  -- confirm_ai_proposal_by_id()'s own validation_status = 'valid' gate below, which is what
  -- actually prevents applying anything less than fully valid, not this bound.
  constraint ai_proposals_changes_is_array check (jsonb_typeof(changes) = 'array'),
  constraint ai_proposals_changes_bounded check (jsonb_array_length(changes) between 0 and 20),
  constraint ai_proposals_rejected_is_array check (jsonb_typeof(rejected) = 'array'),
  constraint ai_proposals_conflicts_after_is_array check (jsonb_typeof(conflicts_after) = 'array'),
  -- confirmed_at / applied_revision_number are set together, only when status = 'confirmed',
  -- and never otherwise — the same "the row's own shape proves its own consistency" pattern
  -- tasks_completed_at_matches_status already uses.
  constraint ai_proposals_confirmed_fields_match_status check (
    (status = 'confirmed' and confirmed_at is not null and applied_revision_number is not null)
    or (status <> 'confirmed' and confirmed_at is null and applied_revision_number is null)
  )
);

create index ai_proposals_user_day_idx on public.ai_proposals (user_id, day_id);

-- Enforced in the database, not application code: at most one 'generated' proposal per day.
create unique index ai_proposals_one_pending_per_day
  on public.ai_proposals (day_id)
  where status = 'generated';

alter table public.ai_proposals enable row level security;

create policy "ai_proposals: select own"
  on public.ai_proposals for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- No insert/update/delete policy: every write goes through a SECURITY DEFINER RPC below, the
-- same posture as tasks/task_history/days/plans/plan_revisions since migration 4.1b.
revoke all on public.ai_proposals from anon, authenticated;
grant select on public.ai_proposals to authenticated;

-- ── 2. create_ai_proposal ────────────────────────────────────────────────
-- The only way a proposal row is created. Atomically supersedes (discards) any existing
-- 'generated' proposal for the same day before inserting the new one, so the partial unique
-- index above is never violated by an ordinary "generate again" — a genuine race between two
-- concurrent generations for the same day still serializes correctly because both statements
-- run inside one transaction per call and the unique index is checked at commit.
--
-- `p_changes`/`p_unresolved` are taken as already-validated JSON built by the application
-- (Phase 5.0's validateProposal + toConfirmationChanges) — this function does not re-derive
-- them, only stores them, exactly as it stores `p_understood`. It DOES enforce the same shape
-- bounds the table's own CHECK constraints require (redundant with them on purpose: a clear
-- 22023 from the function beats a raw constraint-violation error reaching the client).
--
-- Errors: 42501 not authenticated · P0002 day not found for caller · 22023 malformed input
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
  p_validation_status text
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

  if p_source not in ('typed', 'voice') then
    raise exception 'invalid source' using errcode = '22023';
  end if;
  if p_validation_status not in ('valid', 'partially_valid', 'invalid') then
    raise exception 'invalid validation_status' using errcode = '22023';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 20 then
    raise exception 'p_changes must be a JSON array of at most 20 changes' using errcode = '22023';
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
    understood, unresolved, changes, rejected, conflicts_after, validation_status
  )
  values (
    (select auth.uid()), p_day_id, p_base_revision, p_source, p_transcript_text,
    p_understood, p_unresolved, p_changes, p_rejected, p_conflicts_after, p_validation_status
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.create_ai_proposal(uuid, integer, text, text, text, jsonb, jsonb, jsonb, jsonb, text) from public, anon;
grant  execute on function public.create_ai_proposal(uuid, integer, text, text, text, jsonb, jsonb, jsonb, jsonb, text) to authenticated;

-- ── 3. confirm_ai_proposal_by_id ─────────────────────────────────────────
-- The replay-safe confirmation path for a PERSISTED proposal. Reads day_id/base_revision/
-- changes from the stored row itself — never from the caller — so a client can no longer
-- supply a different base_revision or changes than what was actually generated; that entire
-- class of tampering is closed structurally, not merely checked.
--
-- Locking the proposal row with `for update` and requiring status = 'generated' IS the replay
-- guard: a second concurrent call for the same id blocks on that lock until the first
-- transaction commits or rolls back, then finds status <> 'generated' and is refused — no
-- separate idempotency table is needed. confirm_ai_proposal() itself is called unmodified, in
-- the SAME transaction, so "proposal confirmed" and "tasks changed" cannot become inconsistent:
-- if it raises (stale revision, an ineligible task, a conflict, ...), that exception propagates
-- and the whole call — including the row lock and the status update below — rolls back,
-- leaving the proposal exactly as it was (still 'generated', so the user can regenerate).
--
-- Errors: 42501 not authenticated ·
--         P0002 proposal not found / not the caller's / not 'generated' (no cross-user
--               existence is ever revealed — a guessed or foreign id looks identical to a
--               missing one) ·
--         whatever confirm_ai_proposal() itself raises (22023 / P0002 / 40001 / 23P01),
--               unchanged
create function public.confirm_ai_proposal_by_id(
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
  -- Only a fully valid proposal may ever be confirmed (Phase 5.0's own rule — see
  -- toConfirmationChanges() — enforced here in SQL, not merely by a disabled Apply button):
  -- a partially_valid or invalid one may have zero accepted changes, or accepted changes a
  -- human has not seen approved as a coherent whole.
  if v_proposal.validation_status <> 'valid' then
    raise exception 'proposal % is not valid and cannot be confirmed', p_proposal_id
      using errcode = 'P0002';
  end if;

  v_new_rev := public.confirm_ai_proposal(v_proposal.day_id, v_proposal.base_revision, v_proposal.changes);

  update public.ai_proposals
     set status = 'confirmed',
         confirmed_at = now(),
         applied_revision_number = v_new_rev
   where id = v_proposal.id;

  return v_new_rev;
end;
$$;

revoke execute on function public.confirm_ai_proposal_by_id(uuid) from public, anon;
grant  execute on function public.confirm_ai_proposal_by_id(uuid) to authenticated;

-- ── 4. discard_ai_proposal ────────────────────────────────────────────────
-- The user explicitly abandoning a proposal without confirming it (the review UI's Cancel).
-- Only a 'generated' proposal can be discarded; a confirmed or already-discarded one is a
-- no-op success (idempotent — a double-click or a retried request is harmless), matching the
-- "safe rejection, no mutation" posture the rest of this migration follows. Never a generic
-- UPDATE: this is the one narrow, explicit mutation boundary discard gets.
create function public.discard_ai_proposal(
  p_proposal_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  update public.ai_proposals
     set status = 'discarded'
   where id = p_proposal_id
     and user_id = (select auth.uid())
     and status = 'generated';
  -- Deliberately no "not found" error: discarding a proposal that is already gone, already
  -- confirmed, or never the caller's all end in the same safe no-op, and none of those cases
  -- should look different to the caller (or reveal whether the id exists at all).
end;
$$;

revoke execute on function public.discard_ai_proposal(uuid) from public, anon;
grant  execute on function public.discard_ai_proposal(uuid) to authenticated;
