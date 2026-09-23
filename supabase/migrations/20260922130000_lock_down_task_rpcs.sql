-- ─────────────────────────────────────────────────────────────────────────
-- Follow-up to 20260922120000_init_schema.sql — does not modify it.
--
-- Live verification against the linked project (anon-key-only REST/RPC
-- calls, no elevated access) found that `anon` could invoke both
-- create_task_with_history() and change_task_status(), even though the
-- original migration's `revoke all ... from public; grant execute ... to
-- authenticated;` intended to prevent that. Supabase projects set default
-- privileges on the `public` schema that auto-grant EXECUTE on new
-- functions to `anon` (and `authenticated`, `service_role`) separately from
-- the PUBLIC pseudo-role, so revoking from PUBLIC alone doesn't revoke the
-- role-specific grant `anon` already has.
--
-- In practice this was not exploitable: both functions read
-- `(select auth.uid())`, which is null for an anon-only caller, and every
-- code path compares that against a `not null` column — a comparison
-- against null is never true, so the day-ownership check and the
-- `WHERE status = 'upcoming'` guard both fail closed, and anon calls
-- returned "not found" with no row touched or created. This migration
-- closes the gap explicitly rather than relying on that as the only
-- defense. No RLS policy, table, or function body changes here.
--
-- Signatures below were read directly off the live database (not guessed):
--   select p.proname, pg_get_function_identity_arguments(p.oid)
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('create_task_with_history', 'change_task_status');
-- ─────────────────────────────────────────────────────────────────────────

revoke execute on function public.change_task_status(
  p_task_id uuid,
  p_new_status text
) from anon;

revoke execute on function public.change_task_status(
  p_task_id uuid,
  p_new_status text
) from public;

grant execute on function public.change_task_status(
  p_task_id uuid,
  p_new_status text
) to authenticated;

revoke execute on function public.create_task_with_history(
  p_day_id uuid,
  p_title text,
  p_notes text,
  p_priority text,
  p_kind text,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_due_at timestamptz,
  p_source text
) from anon;

revoke execute on function public.create_task_with_history(
  p_day_id uuid,
  p_title text,
  p_notes text,
  p_priority text,
  p_kind text,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_due_at timestamptz,
  p_source text
) from public;

grant execute on function public.create_task_with_history(
  p_day_id uuid,
  p_title text,
  p_notes text,
  p_priority text,
  p_kind text,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_due_at timestamptz,
  p_source text
) to authenticated;

-- service_role is intentionally untouched: it was never granted here and
-- nothing in this migration adds it a privilege it didn't already have.
