-- ─────────────────────────────────────────────────────────────────────────
-- Phase 7: end-of-day intelligence — persisted reports.
--
-- Does the architecture already have a place for this? No: `ai_proposals` is a pre-confirmation
-- scheduling artifact with its own lifecycle (generated → confirmed/discarded) and a confirm path
-- that applies changes; a review has none of that, applies nothing, and must not be able to
-- reach `confirm_ai_proposal_by_id`. `task_history`/`plan_revisions` are append-only FACTS about
-- the schedule and must never hold AI prose. So a report gets its own small table — the same
-- shape of decision Phase 5.5 made for proposals.
--
-- Why persist at all: the facts are fully reproducible from `tasks`/`task_history`/
-- `plan_revisions`, but the AI's interpretation is not — regenerating it on every page view would
-- show a different narrative each refresh, cost a model call per view, and silently rewrite what
-- the user was shown. So a report is a SNAPSHOT: the deterministic facts AND the validated
-- interpretation exactly as they were when it was written. Whether the day has changed since is
-- a live comparison (`state_fingerprint` vs the current persisted task state, computed by the
-- application at read time) — never a stored flag, so nothing needs a background job to stay
-- honest.
--
-- Append-only, like task_history: a report is never updated or deleted (no policy, no grant).
-- Generating again after the day changed appends a NEW row; the old one remains. "Latest" is
-- simply the newest `created_at`. The history of reports is a history of what the user was told,
-- and nothing here lets a later report rewrite an earlier one.
--
-- No task id is stored anywhere: tasks are named by alias (`t1`…) and by their own title inside
-- `facts`. Task NOTES are never part of a report at all.
-- ─────────────────────────────────────────────────────────────────────────

create table public.eod_reports (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  day_id            uuid not null references public.days (id) on delete cascade,
  -- sha-256 (hex) of the persisted task state the report was written against. The application
  -- compares it with the day's current state at read time to tell whether the report is stale.
  state_fingerprint text not null,
  -- Which prompt/tool version produced the interpretation (diagnostics; never used for logic).
  prompt_version    text not null,
  facts             jsonb not null,
  interpretation    jsonb not null,
  created_at        timestamptz not null default now(),
  constraint eod_reports_fingerprint_format check (state_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint eod_reports_prompt_version_format
    check (prompt_version ~ '^[A-Za-z0-9._:-]{1,64}$'),
  constraint eod_reports_facts_is_object check (jsonb_typeof(facts) = 'object'),
  constraint eod_reports_interpretation_is_object check (jsonb_typeof(interpretation) = 'object'),
  constraint eod_reports_facts_bounded check (octet_length(facts::text) <= 65536),
  constraint eod_reports_interpretation_bounded check (octet_length(interpretation::text) <= 16384),
  -- One report per distinct day-state: generating twice against an unchanged day is a replay, not a
  -- new report (the RPC below returns the existing row). This is the idempotency AND the
  -- concurrency guard — two simultaneous generations for the same state cannot both insert.
  constraint eod_reports_one_per_state unique (day_id, state_fingerprint)
);

create index eod_reports_day_created_idx on public.eod_reports (day_id, created_at desc);

alter table public.eod_reports enable row level security;

create policy "eod_reports: select own"
  on public.eod_reports for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- No insert/update/delete policy and no grant: the only writer is create_eod_report() below, the
-- same posture as tasks/task_history/days/plans/plan_revisions/ai_proposals since 4.1b.
--
-- service_role is revoked explicitly: a Supabase project grants it full default privileges on every
-- new table (found by Phase 6 verification — see 20261006090000), and nothing in the cron path has
-- any business with a user's review.
revoke all on public.eod_reports from anon, authenticated, service_role;
grant select on public.eod_reports to authenticated;

-- ── create_eod_report ────────────────────────────────────────────────────
-- The only way a report row is created. SECURITY DEFINER, `search_path = ''`, authenticated-only,
-- no dynamic SQL, every statement filters on the caller.
--
-- It stores what the application hands it, but refuses anything that cannot belong to the day it
-- names:
--   * the day must be the caller's (ownership enforced here, in SQL, not just by the caller);
--   * the day must have STARTED in its own frozen timezone — a report for a future day is refused
--     (22023), the same horizon discipline ensure_day applies in the other direction;
--   * `facts.planningDate` and `facts.timezone` must equal the day's own — a report cannot carry
--     facts about a different day than the one it is filed under;
--   * `facts` must contain between 1 and 100 tasks (an empty day has nothing to review and is never
--     stored) and a totals object; `interpretation` must have the closed set of keys with the right
--     JSON types and length bounds. The application validates all of this first (Zod + the domain
--     validator); these checks are the backstop, redundant on purpose so a clear 22023 beats a raw
--     constraint violation reaching the client.
--
-- Replay / idempotency: if a report already exists for (day, fingerprint) it is returned
-- unchanged and nothing is written — the FIRST report for a given state stands. A genuine race
-- (two simultaneous calls) is settled by the unique constraint: the loser's insert is a no-op and
-- it returns the winner's row. At most 20 reports per day (54000): every new row needs the day to
-- have actually changed, so this is a ceiling on churn, not a limit on honest use.
--
-- Errors: 42501 not authenticated · P0002 day not found for caller · 22023 malformed input or a
-- day that has not started · 54000 too many reports for the day
create function public.create_eod_report(
  p_day_id            uuid,
  p_state_fingerprint text,
  p_prompt_version    text,
  p_facts             jsonb,
  p_interpretation    jsonb
)
returns public.eod_reports
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_day public.days;
  v_row public.eod_reports;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select * into v_day from public.days where id = p_day_id and user_id = v_uid;
  if not found then
    raise exception 'day % not found for current user', p_day_id using errcode = 'P0002';
  end if;

  if (now() at time zone v_day.timezone)::date < v_day.local_date then
    raise exception 'that day has not started yet' using errcode = '22023';
  end if;

  if p_state_fingerprint is null or p_state_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid state fingerprint' using errcode = '22023';
  end if;
  if p_prompt_version is null or p_prompt_version !~ '^[A-Za-z0-9._:-]{1,64}$' then
    raise exception 'invalid prompt version' using errcode = '22023';
  end if;

  if p_facts is null or jsonb_typeof(p_facts) is distinct from 'object'
     or octet_length(p_facts::text) > 65536 then
    raise exception 'p_facts must be a JSON object of at most 64 KiB' using errcode = '22023';
  end if;
  if jsonb_typeof(p_facts -> 'tasks') is distinct from 'array'
     or jsonb_array_length(p_facts -> 'tasks') not between 1 and 100 then
    raise exception 'facts.tasks must be an array of 1 to 100 tasks' using errcode = '22023';
  end if;
  if jsonb_typeof(p_facts -> 'totals') is distinct from 'object' then
    raise exception 'facts.totals must be an object' using errcode = '22023';
  end if;
  if (p_facts ->> 'planningDate') is distinct from v_day.local_date::text
     or (p_facts ->> 'timezone') is distinct from v_day.timezone then
    raise exception 'facts do not describe this day' using errcode = '22023';
  end if;

  if p_interpretation is null or jsonb_typeof(p_interpretation) is distinct from 'object'
     or octet_length(p_interpretation::text) > 16384 then
    raise exception 'p_interpretation must be a JSON object of at most 16 KiB' using errcode = '22023';
  end if;
  if jsonb_typeof(p_interpretation -> 'summary') is distinct from 'string'
     or char_length(p_interpretation ->> 'summary') not between 1 and 400
     or jsonb_typeof(p_interpretation -> 'takeaway') is distinct from 'string'
     or char_length(p_interpretation ->> 'takeaway') not between 1 and 200
     or jsonb_typeof(p_interpretation -> 'patterns') is distinct from 'array'
     or jsonb_array_length(p_interpretation -> 'patterns') > 3
     or jsonb_typeof(p_interpretation -> 'carryForward') is distinct from 'array'
     or jsonb_array_length(p_interpretation -> 'carryForward') > 5 then
    raise exception 'p_interpretation does not have the expected shape' using errcode = '22023';
  end if;

  -- Replay: the first report for this exact day-state stands.
  select * into v_row from public.eod_reports
   where day_id = p_day_id and user_id = v_uid and state_fingerprint = p_state_fingerprint;
  if found then
    return v_row;
  end if;

  if (select count(*) from public.eod_reports where day_id = p_day_id and user_id = v_uid) >= 20 then
    raise exception 'too many reports for this day' using errcode = '54000';
  end if;

  insert into public.eod_reports
    (user_id, day_id, state_fingerprint, prompt_version, facts, interpretation)
  values
    (v_uid, p_day_id, p_state_fingerprint, p_prompt_version, p_facts, p_interpretation)
  on conflict (day_id, state_fingerprint) do nothing
  returning * into v_row;

  if not found then
    -- Lost a race with a simultaneous identical call: return the winner's row.
    select * into v_row from public.eod_reports
     where day_id = p_day_id and user_id = v_uid and state_fingerprint = p_state_fingerprint;
  end if;

  return v_row;
end;
$$;

-- service_role is revoked explicitly for the same reason as the table above.
revoke execute on function public.create_eod_report(uuid, text, text, jsonb, jsonb)
  from public, anon, service_role;
grant execute on function public.create_eod_report(uuid, text, text, jsonb, jsonb)
  to authenticated;
