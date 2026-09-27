-- ─────────────────────────────────────────────────────────────────────────
-- Push subscription isolation check for Phase 6.1.
--
-- Same technique as rls_isolation.sql: two throwaway auth.users rows, impersonated via the
-- `request.jwt.claims` GUC (what auth.uid() actually reads on a real request), everything
-- inside one transaction, rolled back at the end. Run it against a real Postgres with this
-- migration applied:
--
--   supabase start
--   supabase db reset
--   psql "$(supabase status -o env | grep DB_URL | cut -d= -f2)" \
--        -f supabase/tests/push_subscriptions_isolation.sql
--
-- Prints "CASE N: ... OK" for each case below and "PUSH SUBSCRIPTIONS ISOLATION OK" at the end
-- on success; any failed assertion raises and aborts the transaction. Numbered comments below
-- map directly to the 18 security/invariant cases Phase 6.1's verification required.
-- ─────────────────────────────────────────────────────────────────────────

begin;

insert into auth.users (id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'user-a@example.test', '', now(), now()),
  ('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'authenticated', 'user-b@example.test', '', now(), now());

set local role authenticated;

-- ── Cases 1-3: register, idempotent re-register, a second device ───────────
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);

select public.register_push_subscription(
  'https://push.example.test/ep1', 'p256dh-ep1-v1', 'auth-ep1-v1'
);
do $$
begin
  if (select count(*) from public.push_subscriptions
       where endpoint = 'https://push.example.test/ep1'
         and user_id = '00000000-0000-0000-0000-0000000000a1'
         and revoked_at is null) <> 1 then
    raise exception 'CASE 1 FAILED: registering a new endpoint did not create exactly one active row';
  end if;
end $$;
do $$ begin raise notice 'CASE 1: register endpoint A succeeds — OK'; end $$;

select pg_sleep(0.01); -- ensure a distinguishable last_seen_at on refresh
select public.register_push_subscription(
  'https://push.example.test/ep1', 'p256dh-ep1-v2', 'auth-ep1-v2'
);
do $$
declare
  v_count int;
  v_p256dh text;
begin
  select count(*), max(p256dh) into v_count, v_p256dh
    from public.push_subscriptions where endpoint = 'https://push.example.test/ep1';
  if v_count <> 1 then
    raise exception 'CASE 2 FAILED: re-registering the same endpoint created a duplicate row (count=%)', v_count;
  end if;
  if v_p256dh <> 'p256dh-ep1-v2' then
    raise exception 'CASE 2 FAILED: re-registration did not refresh the stored keys';
  end if;
end $$;
do $$ begin raise notice 'CASE 2: re-registering endpoint A is idempotent, no duplicate — OK'; end $$;

select public.register_push_subscription(
  'https://push.example.test/ep2', 'p256dh-ep2', 'auth-ep2'
);
do $$
begin
  if (select count(*) from public.push_subscriptions
       where user_id = '00000000-0000-0000-0000-0000000000a1' and revoked_at is null) <> 2 then
    raise exception 'CASE 3 FAILED: user A should now hold 2 active subscriptions (multi-device)';
  end if;
end $$;
do $$ begin raise notice 'CASE 3: register endpoint B (second device) succeeds — OK'; end $$;

-- ── Case 15: endpoint uniqueness is a real database constraint, not just RPC logic ──────────
-- `authenticated` has no INSERT grant at all (that's cases 7-9, below), so testing the UNIQUE
-- constraint itself needs a role that can actually attempt the insert — the table owner
-- (postgres), which still obeys real data constraints even though it bypasses grants.
reset role;
do $$
declare
  v_refused boolean := false;
begin
  begin
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth_key)
    values ('00000000-0000-0000-0000-0000000000b2', 'https://push.example.test/ep1', 'x', 'y');
  exception when unique_violation then v_refused := true;
  end;
  if not v_refused then
    raise exception 'CASE 15 FAILED: a second row for the same endpoint was allowed';
  end if;
end $$;
do $$ begin raise notice 'CASE 15: endpoint uniqueness enforced at the database level — OK'; end $$;
set local role authenticated;

-- ── Case 6: user B cannot take over user A's still-ACTIVE endpoint ──────────────────────────
select public.register_push_subscription(
  'https://push.example.test/ep3', 'p256dh-ep3-a', 'auth-ep3-a'
);

select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text,
  true);

do $$
declare
  v_unexpectedly_succeeded boolean := false;
begin
  begin
    perform public.register_push_subscription(
      'https://push.example.test/ep3', 'p256dh-ep3-b', 'auth-ep3-b'
    );
    v_unexpectedly_succeeded := true;
  exception when sqlstate 'P0002' then
    null; -- expected: still actively owned by A
  end;
  if v_unexpectedly_succeeded then
    raise exception 'CASE 6 FAILED: user B took over user A''s active endpoint';
  end if;
  if exists (
    select 1 from public.push_subscriptions
     where endpoint = 'https://push.example.test/ep3'
       and (user_id <> '00000000-0000-0000-0000-0000000000a1'
            or p256dh <> 'p256dh-ep3-a' or auth_key <> 'auth-ep3-a' or revoked_at is not null)
  ) then
    raise exception 'CASE 6 FAILED: user A''s row was modified by user B''s attempt';
  end if;
end $$;
do $$ begin raise notice 'CASE 6: user B cannot take over user A''s active endpoint — OK'; end $$;

-- ── Case 5: user B cannot revoke user A's endpoint ──────────────────────────────────────────
select public.revoke_push_subscription('https://push.example.test/ep3'); -- B, still impersonated
do $$
begin
  if (select revoked_at from public.push_subscriptions
       where endpoint = 'https://push.example.test/ep3') is not null then
    raise exception 'CASE 5 FAILED: user B revoked user A''s endpoint';
  end if;
end $$;
do $$ begin raise notice 'CASE 5: user B cannot revoke user A''s endpoint (silent no-op) — OK'; end $$;

-- ── Case 4 + 14: the OWNER revokes, then re-registers the same endpoint ─────────────────────
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);

select public.revoke_push_subscription('https://push.example.test/ep3');
do $$
begin
  if (select revoked_at from public.push_subscriptions
       where endpoint = 'https://push.example.test/ep3') is null then
    raise exception 'CASE 4 FAILED: user A could not revoke their own endpoint';
  end if;
end $$;
do $$ begin raise notice 'CASE 4: user A revokes their own endpoint — OK'; end $$;

select public.register_push_subscription(
  'https://push.example.test/ep3', 'p256dh-ep3-a2', 'auth-ep3-a2'
);
do $$
declare
  v_row public.push_subscriptions;
begin
  select * into v_row from public.push_subscriptions where endpoint = 'https://push.example.test/ep3';
  if v_row.revoked_at is not null then
    raise exception 'CASE 14 FAILED: re-registering did not clear revoked_at';
  end if;
  if v_row.user_id <> '00000000-0000-0000-0000-0000000000a1' then
    raise exception 'CASE 14 FAILED: ownership changed on the owner''s own re-registration';
  end if;
  if v_row.p256dh <> 'p256dh-ep3-a2' then
    raise exception 'CASE 14 FAILED: keys were not refreshed on re-registration';
  end if;
end $$;
do $$ begin raise notice 'CASE 14: owner re-registering a revoked endpoint reactivates it correctly — OK'; end $$;

-- ── Bonus (beyond the 18 mandated cases): once REVOKED, a DIFFERENT user MAY claim the
-- endpoint — the deliberate other half of the ownership design in the migration. Cases 5/6
-- above prove an ACTIVE endpoint can't be touched by a stranger; this proves a genuinely
-- abandoned one can be adopted, which is what makes the shared-device sign-out/sign-in flow
-- actually work.
select public.revoke_push_subscription('https://push.example.test/ep3'); -- A abandons it again

select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text,
  true);
select public.register_push_subscription(
  'https://push.example.test/ep3', 'p256dh-ep3-b2', 'auth-ep3-b2'
);
do $$
declare
  v_row public.push_subscriptions;
begin
  select * into v_row from public.push_subscriptions where endpoint = 'https://push.example.test/ep3';
  if v_row.user_id <> '00000000-0000-0000-0000-0000000000b2' or v_row.revoked_at is not null then
    raise exception 'BONUS FAILED: a revoked, abandoned endpoint could not be adopted by a new owner';
  end if;
end $$;
do $$ begin raise notice 'BONUS: a REVOKED endpoint can be adopted by a different user — OK'; end $$;

-- ── Cases 7-9: no direct table writes for an ordinary authenticated user, even on their own row ──
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);

do $$
declare v_refused boolean := false;
begin
  begin
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth_key)
    values ('00000000-0000-0000-0000-0000000000a1', 'https://push.example.test/forged', 'x', 'y');
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then raise exception 'CASE 7 FAILED: a direct INSERT was allowed'; end if;
end $$;
do $$ begin raise notice 'CASE 7: direct INSERT denied for an authenticated user — OK'; end $$;

do $$
declare v_refused boolean := false;
begin
  begin
    update public.push_subscriptions set last_seen_at = now()
     where endpoint = 'https://push.example.test/ep1';
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then raise exception 'CASE 8 FAILED: a direct UPDATE was allowed, even on the caller''s own row'; end if;
end $$;
do $$ begin raise notice 'CASE 8: direct UPDATE denied, even on the caller''s own row — OK'; end $$;

do $$
declare v_refused boolean := false;
begin
  begin
    delete from public.push_subscriptions where endpoint = 'https://push.example.test/ep1';
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then raise exception 'CASE 9 FAILED: a direct DELETE was allowed, even on the caller''s own row'; end if;
end $$;
do $$ begin raise notice 'CASE 9: direct DELETE denied, even on the caller''s own row — OK'; end $$;

-- ── Cases 12-13: SELECT is scoped strictly by RLS, in both directions ───────────────────────
do $$
declare v_foreign_rows int;
begin
  select count(*) into v_foreign_rows from public.push_subscriptions
   where user_id <> '00000000-0000-0000-0000-0000000000a1';
  if v_foreign_rows <> 0 then
    raise exception 'CASE 12 FAILED: user A can see % row(s) not owned by them', v_foreign_rows;
  end if;
  if (select count(*) from public.push_subscriptions
       where user_id = '00000000-0000-0000-0000-0000000000a1') <> 2 then
    raise exception 'CASE 12 FAILED: user A does not see exactly their own 2 active subscriptions (ep1, ep2)';
  end if;
end $$;
do $$ begin raise notice 'CASE 12: user A sees only their own rows — OK'; end $$;

select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text,
  true);
do $$
declare v_foreign_rows int;
begin
  select count(*) into v_foreign_rows from public.push_subscriptions
   where user_id = '00000000-0000-0000-0000-0000000000a1';
  if v_foreign_rows <> 0 then
    raise exception 'CASE 13 FAILED: user B can see % of user A''s row(s)', v_foreign_rows;
  end if;
  if (select count(*) from public.push_subscriptions
       where user_id = '00000000-0000-0000-0000-0000000000b2') <> 1 then
    raise exception 'CASE 13 FAILED: user B does not see exactly their own row (ep3, adopted above)';
  end if;
end $$;
do $$ begin raise notice 'CASE 13: user B cannot see any of user A''s rows — OK'; end $$;

-- ── Cases 10-11: anonymous cannot call either RPC ───────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;

do $$
declare v_refused boolean := false;
begin
  begin
    perform public.register_push_subscription('https://push.example.test/anon', 'p', 'a');
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then raise exception 'CASE 10 FAILED: anon could call register_push_subscription'; end if;
end $$;
do $$ begin raise notice 'CASE 10: anonymous register_push_subscription denied — OK'; end $$;

do $$
declare v_refused boolean := false;
begin
  begin
    perform public.revoke_push_subscription('https://push.example.test/ep1');
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then raise exception 'CASE 11 FAILED: anon could call revoke_push_subscription'; end if;
end $$;
do $$ begin raise notice 'CASE 11: anonymous revoke_push_subscription denied — OK'; end $$;

do $$
declare v_refused boolean := false;
begin
  begin
    perform count(*) from public.push_subscriptions;
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then raise exception 'CASE 10b FAILED: anon could SELECT push_subscriptions (no grant expected at all)'; end if;
end $$;
do $$ begin raise notice 'CASE 10b: anonymous SELECT on push_subscriptions denied — OK'; end $$;

reset role;

-- ── Case 16-17: the RPCs cannot be abused through parameters, and are properly hardened ─────
-- 16: there is no user-id-shaped parameter to abuse in the first place — provable from the
-- catalog, not just behaviorally. 17: SECURITY DEFINER + search_path='' are real properties
-- of the compiled function, and the internal auth.uid() check is independent of grants — even
-- the table owner, calling with no JWT claim at all, is refused by the FUNCTION BODY itself.
do $$
declare
  v_argnames text[];
begin
  select proargnames into v_argnames
    from pg_proc where proname = 'register_push_subscription' and pronamespace = 'public'::regnamespace;
  if v_argnames && array['p_user_id', 'user_id', 'p_userid', 'userid']::text[] then
    raise exception 'CASE 16 FAILED: register_push_subscription accepts a user-id-shaped parameter';
  end if;

  select proargnames into v_argnames
    from pg_proc where proname = 'revoke_push_subscription' and pronamespace = 'public'::regnamespace;
  if v_argnames && array['p_user_id', 'user_id', 'p_userid', 'userid']::text[] then
    raise exception 'CASE 16 FAILED: revoke_push_subscription accepts a user-id-shaped parameter';
  end if;
end $$;
do $$ begin raise notice 'CASE 16: neither RPC accepts a client-suppliable identity parameter — OK'; end $$;

do $$
declare
  v_secdef boolean;
  v_config text[];
begin
  select prosecdef, proconfig into v_secdef, v_config
    from pg_proc where proname = 'register_push_subscription' and pronamespace = 'public'::regnamespace;
  if not v_secdef then raise exception 'CASE 17 FAILED: register_push_subscription is not SECURITY DEFINER'; end if;
  if not exists (select 1 from unnest(v_config) c where c in ('search_path=""', 'search_path=')) then
    raise exception 'CASE 17 FAILED: register_push_subscription does not set search_path to empty (saw %)', v_config;
  end if;

  select prosecdef, proconfig into v_secdef, v_config
    from pg_proc where proname = 'revoke_push_subscription' and pronamespace = 'public'::regnamespace;
  if not v_secdef then raise exception 'CASE 17 FAILED: revoke_push_subscription is not SECURITY DEFINER'; end if;
  if not exists (select 1 from unnest(v_config) c where c in ('search_path=""', 'search_path=')) then
    raise exception 'CASE 17 FAILED: revoke_push_subscription does not set search_path to empty (saw %)', v_config;
  end if;
end $$;
do $$ begin raise notice 'CASE 17a: both RPCs are SECURITY DEFINER with search_path = '''' — OK'; end $$;

-- The internal check, exercised directly: superuser privilege alone is not enough without a
-- JWT claim — the function's own `auth.uid() is null` guard is what actually refuses this,
-- independent of any grant.
select set_config('request.jwt.claims', '', true);
do $$
declare v_refused boolean := false;
begin
  begin
    perform public.register_push_subscription('https://push.example.test/nouid', 'p', 'a');
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then
    raise exception 'CASE 17 FAILED: register_push_subscription succeeded with auth.uid() null';
  end if;
end $$;
do $$ begin raise notice 'CASE 17b: the RPC''s own auth.uid() IS NULL check is real, independent of grants — OK'; end $$;

-- ── Case 18: the grant model is exactly what it should be — nothing more, nothing less ──────
do $$
declare
  v_table_privs text[];
  v_anon_execute int;
  v_authenticated_execute int;
begin
  select array_agg(privilege_type order by privilege_type) into v_table_privs
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'push_subscriptions'
     and grantee = 'authenticated';
  if v_table_privs <> array['SELECT'] then
    raise exception 'CASE 18 FAILED: authenticated''s table privileges on push_subscriptions are % (expected only SELECT)', v_table_privs;
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'push_subscriptions' and grantee = 'anon'
  ) then
    raise exception 'CASE 18 FAILED: anon has some grant on push_subscriptions (expected none)';
  end if;

  select count(*) into v_authenticated_execute
    from information_schema.role_routine_grants
   where routine_schema = 'public'
     and routine_name in ('register_push_subscription', 'revoke_push_subscription')
     and grantee = 'authenticated' and privilege_type = 'EXECUTE';
  if v_authenticated_execute <> 2 then
    raise exception 'CASE 18 FAILED: authenticated does not have EXECUTE on exactly both RPCs (saw %)', v_authenticated_execute;
  end if;

  select count(*) into v_anon_execute
    from information_schema.role_routine_grants
   where routine_schema = 'public'
     and routine_name in ('register_push_subscription', 'revoke_push_subscription')
     and grantee = 'anon' and privilege_type = 'EXECUTE';
  if v_anon_execute <> 0 then
    raise exception 'CASE 18 FAILED: anon has EXECUTE on a push_subscriptions RPC (saw % grants)', v_anon_execute;
  end if;

  if exists (
    select 1 from information_schema.role_routine_grants
     where routine_schema = 'public'
       and routine_name in ('register_push_subscription', 'revoke_push_subscription')
       and grantee = 'service_role'
  ) then
    raise exception 'CASE 18 FAILED: service_role has a grant on a Phase 6.1 RPC (none expected in this phase)';
  end if;
end $$;
do $$ begin raise notice 'CASE 18: grants are exactly SELECT-only for authenticated, EXECUTE-only on both RPCs, nothing for anon or service_role — OK'; end $$;

do $$
begin
  raise notice 'PUSH SUBSCRIPTIONS ISOLATION OK';
end $$;

rollback;
