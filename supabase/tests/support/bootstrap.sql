-- ─────────────────────────────────────────────────────────────────────────
-- Minimal Supabase-shaped bootstrap for a PLAIN Postgres, so every migration and every SQL suite can
-- run from an empty database (CI, or a developer's scratch server). It is test scaffolding only — a
-- real Supabase project already has all of this and this file must never be applied to one.
--
-- It provides exactly what the migrations and suites reference, and nothing more:
--   * the three API roles Supabase defines (anon, authenticated, service_role — the last with
--     BYPASSRLS, as on Supabase);
--   * an `auth` schema with the minimal `auth.users` table (the foreign-key target), and the two
--     helper functions the RLS policies and RPCs read the caller's identity through, `auth.uid()` and
--     `auth.role()`, implemented the way Supabase does: from the `request.jwt.claims` setting that
--     PostgREST sets per request (the suites set the same setting to impersonate users);
--   * Supabase's DEFAULT PRIVILEGES: every table, function and sequence later created in `public`
--     is granted to all three roles. This is the part that matters most. Supabase hands new objects
--     to anon/authenticated/service_role by default, so every migration must explicitly revoke what a
--     role should not have — a plain Postgres would hide a missing revoke, and Phase 6 found exactly
--     that bug. Reproducing the default is what makes the suites meaningful.
--
-- Roles are cluster-wide, so the role creation is guarded and the file can be applied to a second
-- database on the same server.
-- ─────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

create schema auth;

create table auth.users (
  id                 uuid primary key,
  aud                text,
  role               text,
  email              text,
  encrypted_password text,
  created_at         timestamptz,
  updated_at         timestamptz
);

create function auth.uid() returns uuid
language sql stable as $$
  select nullif((nullif(current_setting('request.jwt.claims', true), '')::json) ->> 'sub', '')::uuid
$$;

create function auth.role() returns text
language sql stable as $$
  select nullif((nullif(current_setting('request.jwt.claims', true), '')::json) ->> 'role', '')
$$;

grant usage on schema auth   to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase's defaults for objects created by the migration role in `public`.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
