-- ─────────────────────────────────────────────────────────────────────────
-- Notification delivery isolation check for Phase 6.3.
--
-- Same technique as rls_isolation.sql / push_subscriptions_isolation.sql /
-- scheduled_notifications_isolation.sql: throwaway auth.users rows, impersonated via the
-- `request.jwt.claims` GUC, everything inside one transaction, rolled back at the end. Run
-- against a real Postgres with every migration applied:
--
--   supabase start
--   supabase db reset
--   psql "$(supabase status -o env | grep DB_URL | cut -d= -f2)" \
--        -f supabase/tests/notification_delivery_isolation.sql
--
-- Phase 6.3 adds no table and no delivery logic to SQL — this covers exactly the two new RPCs
-- (`mark_notification_sent`, `revoke_push_subscription_by_id`) and the two new read grants
-- (tasks/push_subscriptions to service_role), which is everything about Phase 6.3 that a real
-- database can prove. Web Push HTTP delivery itself is verified by the mocked TypeScript
-- provider/service tests — there is no way, and no need, to exercise a real push provider here.
-- ─────────────────────────────────────────────────────────────────────────

begin;

insert into auth.users (id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'user-a@example.test', '', now(), now()),
  ('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'authenticated', 'user-b@example.test', '', now(), now());

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);

insert into public.profiles (id, timezone) values ('00000000-0000-0000-0000-0000000000a1', 'UTC');
select * from public.ensure_day() \gset a_day_
select id as task_id from public.create_task_with_history(
  :'a_day_id', 'due soon', null, 'medium', 'flexible',
  now() + interval '9 minutes', now() + interval '39 minutes', null, 'user'
) \gset
-- Bridged into a GUC (readable via current_setting inside `do $$ $$` blocks below): psql's own
-- `:'var'` interpolation does not reach inside a dollar-quoted PL/pgSQL body.
select set_config('test.task_id', :'task_id', true);

select public.register_push_subscription('https://push.example.test/e1', 'p256dh-1', 'auth-1');

set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
select id as notification_id from public.reconcile_and_claim_notifications() \gset
select set_config('test.notification_id', :'notification_id', true);
-- The "due soon" task's reminder was created and immediately claimed (fire_at already past),
-- exactly as Phase 6.2's own isolation test already proves — this file starts from there.
do $$
begin
  if (select status from public.scheduled_notifications) <> 'claimed' then
    raise exception 'setup failed: expected exactly one claimed notification';
  end if;
end $$;

-- ── Case: service_role can now read tasks and push_subscriptions (Phase 6.3's new grants) ───
do $$
declare v_title text; v_sub_count int;
begin
  select title into v_title from public.tasks where id = current_setting('test.task_id')::uuid;
  if v_title <> 'due soon' then raise exception 'service_role could not read the task title'; end if;
  select count(*) into v_sub_count from public.push_subscriptions where revoked_at is null;
  if v_sub_count <> 1 then raise exception 'service_role could not read the active subscription'; end if;
end $$;
do $$ begin raise notice 'CASE: service_role can read tasks and push_subscriptions (new Phase 6.3 grants) — OK'; end $$;

-- ── Case: authenticated still cannot write either table (Phase 6.3 adds no write grant) ─────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);
do $$
declare v_refused boolean := false;
begin
  begin
    update public.tasks set title = 'hijacked' where id = current_setting('test.task_id')::uuid;
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then raise exception 'CASE FAILED: a direct UPDATE on tasks was allowed'; end if;
end $$;
do $$ begin raise notice 'CASE: authenticated still cannot write tasks — OK'; end $$;

set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

-- ── mark_notification_sent: happy path ───────────────────────────────────────────────────────
select public.mark_notification_sent(:'notification_id');
do $$
declare v_row public.scheduled_notifications;
begin
  select * into v_row from public.scheduled_notifications where id = current_setting('test.notification_id')::uuid;
  if v_row.status <> 'sent' or v_row.resolved_at is null then
    raise exception 'CASE FAILED: mark_notification_sent did not mark the claimed row sent (status=%)', v_row.status;
  end if;
end $$;
do $$ begin raise notice 'CASE: mark_notification_sent marks a claimed row sent, sets resolved_at — OK'; end $$;

-- ── mark_notification_sent is idempotent/silent on an already-resolved row ──────────────────
select public.mark_notification_sent(:'notification_id');
do $$
begin
  if (select status from public.scheduled_notifications where id = current_setting('test.notification_id')::uuid) <> 'sent' then
    raise exception 'CASE FAILED: calling mark_notification_sent twice changed the outcome';
  end if;
end $$;
do $$ begin raise notice 'CASE: mark_notification_sent is idempotent on an already-sent row — OK'; end $$;

-- ── mark_notification_sent only affects a currently-`claimed` row — never a `scheduled` one ──
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);
select id as task2_id from public.create_task_with_history(
  :'a_day_id', 'not due yet', null, 'medium', 'flexible',
  now() + interval '20 minutes', now() + interval '50 minutes', null, 'user'
) \gset
select set_config('test.task2_id', :'task2_id', true);

set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
select public.reconcile_and_claim_notifications(); -- creates task2's reminder as 'scheduled' (not due)
do $$
declare v_id uuid; v_status_before text;
begin
  select id, status into v_id, v_status_before from public.scheduled_notifications
   where task_id = current_setting('test.task2_id')::uuid;
  if v_status_before <> 'scheduled' then
    raise exception 'setup failed: task2''s reminder should be scheduled, not %', v_status_before;
  end if;
  perform public.mark_notification_sent(v_id);
  if (select status from public.scheduled_notifications where id = v_id) <> 'scheduled' then
    raise exception 'CASE FAILED: mark_notification_sent affected a row that was not claimed';
  end if;
end $$;
do $$ begin raise notice 'CASE: mark_notification_sent is a no-op on a non-claimed row — OK'; end $$;

-- ── revoke_push_subscription_by_id: happy path ───────────────────────────────────────────────
do $$
declare v_sub_id uuid;
begin
  select id into v_sub_id from public.push_subscriptions where endpoint = 'https://push.example.test/e1';
  perform public.revoke_push_subscription_by_id(v_sub_id);
  if (select revoked_at from public.push_subscriptions where id = v_sub_id) is null then
    raise exception 'CASE FAILED: revoke_push_subscription_by_id did not revoke the subscription';
  end if;
end $$;
do $$ begin raise notice 'CASE: revoke_push_subscription_by_id revokes (sets revoked_at) — OK'; end $$;

-- ── revoke_push_subscription_by_id is idempotent/silent on an already-revoked or missing id ──
do $$
declare v_sub_id uuid; v_revoked_at_before timestamptz;
begin
  select id, revoked_at into v_sub_id, v_revoked_at_before from public.push_subscriptions
   where endpoint = 'https://push.example.test/e1';
  perform public.revoke_push_subscription_by_id(v_sub_id); -- already revoked
  if (select revoked_at from public.push_subscriptions where id = v_sub_id) <> v_revoked_at_before then
    raise exception 'CASE FAILED: revoking an already-revoked subscription changed its timestamp';
  end if;
  perform public.revoke_push_subscription_by_id('00000000-0000-0000-0000-000000000000'); -- missing id, must not error
end $$;
do $$ begin raise notice 'CASE: revoke_push_subscription_by_id is silent on already-revoked/missing ids — OK'; end $$;

-- ── Neither new RPC accepts a user-id-shaped parameter (nothing to bypass) ───────────────────
do $$
declare v_argnames text[];
begin
  select proargnames into v_argnames from pg_proc
   where proname = 'mark_notification_sent' and pronamespace = 'public'::regnamespace;
  if v_argnames && array['p_user_id', 'user_id']::text[] then
    raise exception 'CASE FAILED: mark_notification_sent accepts a user-id-shaped parameter';
  end if;
  select proargnames into v_argnames from pg_proc
   where proname = 'revoke_push_subscription_by_id' and pronamespace = 'public'::regnamespace;
  if v_argnames && array['p_user_id', 'user_id']::text[] then
    raise exception 'CASE FAILED: revoke_push_subscription_by_id accepts a user-id-shaped parameter';
  end if;
end $$;
do $$ begin raise notice 'CASE: neither new RPC accepts a client-suppliable identity parameter — OK'; end $$;

-- ── SECURITY DEFINER + search_path = '' for both new functions ──────────────────────────────
do $$
declare v_secdef boolean; v_config text[];
begin
  for v_secdef, v_config in
    select prosecdef, proconfig from pg_proc
     where proname in ('mark_notification_sent', 'revoke_push_subscription_by_id')
       and pronamespace = 'public'::regnamespace
  loop
    if not v_secdef then raise exception 'CASE FAILED: a Phase 6.3 RPC is not SECURITY DEFINER'; end if;
    if not exists (select 1 from unnest(v_config) c where c in ('search_path=""', 'search_path=')) then
      raise exception 'CASE FAILED: a Phase 6.3 RPC does not set search_path to empty (saw %)', v_config;
    end if;
  end loop;
end $$;
do $$ begin raise notice 'CASE: both new RPCs are SECURITY DEFINER with search_path = '''' — OK'; end $$;

-- ── The internal auth.role() check is real, independent of the EXECUTE grant ─────────────────
-- The grant boundary alone (EXECUTE revoked from authenticated/anon) already refuses an
-- ordinary caller with 42501 before the function body ever runs — the test below that proves
-- "authenticated/anon cannot invoke" would still pass even if the INTERNAL check were removed
-- entirely, since it never actually reaches the body. This is the test that does: superuser
-- bypasses the grant boundary completely (like `postgres`, the function owner, always does),
-- so if the function still refuses without a service_role JWT claim, that refusal can only be
-- coming from the internal check — exactly the defense-in-depth Phase 6.2's own RPC already
-- proved (see its own isolation test's CASE 17).
reset role;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
do $$
declare v_refused boolean := false;
begin
  begin
    perform public.mark_notification_sent(current_setting('test.notification_id')::uuid);
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then
    raise exception 'CASE FAILED: mark_notification_sent succeeded for a superuser without a service_role JWT claim';
  end if;
end $$;
do $$
declare v_refused boolean := false;
begin
  begin
    perform public.revoke_push_subscription_by_id('00000000-0000-0000-0000-000000000000');
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then
    raise exception 'CASE FAILED: revoke_push_subscription_by_id succeeded for a superuser without a service_role JWT claim';
  end if;
end $$;
do $$ begin raise notice 'CASE: both new RPCs'' own auth.role() = service_role check is real, independent of grants — OK'; end $$;

-- ── Neither ordinary authenticated users nor anon can invoke either new system RPC ───────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);
do $$
declare v_refused boolean := false;
begin
  begin
    perform public.mark_notification_sent('00000000-0000-0000-0000-000000000000');
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then raise exception 'CASE FAILED: authenticated could call mark_notification_sent'; end if;
end $$;
do $$
declare v_refused boolean := false;
begin
  begin
    perform public.revoke_push_subscription_by_id('00000000-0000-0000-0000-000000000000');
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then raise exception 'CASE FAILED: authenticated could call revoke_push_subscription_by_id'; end if;
end $$;
do $$ begin raise notice 'CASE: an ordinary authenticated user cannot invoke either new system RPC — OK'; end $$;

reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;
do $$
declare v_refused boolean := false;
begin
  begin
    perform public.mark_notification_sent('00000000-0000-0000-0000-000000000000');
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then raise exception 'CASE FAILED: anon could call mark_notification_sent'; end if;
end $$;
do $$
declare v_refused boolean := false;
begin
  begin
    perform public.revoke_push_subscription_by_id('00000000-0000-0000-0000-000000000000');
  exception when sqlstate '42501' then v_refused := true;
  end;
  if not v_refused then raise exception 'CASE FAILED: anon could call revoke_push_subscription_by_id'; end if;
end $$;
do $$ begin raise notice 'CASE: anon cannot invoke either new system RPC — OK'; end $$;
reset role;

-- ── Grants: service_role has SELECT on tasks/push_subscriptions and nothing broader ──────────
do $$
declare v_task_privs text[]; v_sub_privs text[];
begin
  select array_agg(privilege_type order by privilege_type) into v_task_privs
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'tasks' and grantee = 'service_role';
  if v_task_privs <> array['SELECT'] then
    raise exception 'CASE FAILED: service_role''s privileges on tasks are % (expected only SELECT)', v_task_privs;
  end if;

  select array_agg(privilege_type order by privilege_type) into v_sub_privs
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'push_subscriptions' and grantee = 'service_role';
  if v_sub_privs <> array['SELECT'] then
    raise exception 'CASE FAILED: service_role''s privileges on push_subscriptions are % (expected only SELECT)', v_sub_privs;
  end if;
end $$;
do $$ begin raise notice 'CASE: service_role has exactly SELECT on tasks and push_subscriptions, nothing more — OK'; end $$;

do $$
declare v_authenticated_execute int; v_anon_execute int; v_service_role_execute int;
begin
  select count(*) into v_authenticated_execute from information_schema.role_routine_grants
   where routine_schema = 'public'
     and routine_name in ('mark_notification_sent', 'revoke_push_subscription_by_id')
     and grantee = 'authenticated';
  select count(*) into v_anon_execute from information_schema.role_routine_grants
   where routine_schema = 'public'
     and routine_name in ('mark_notification_sent', 'revoke_push_subscription_by_id')
     and grantee = 'anon';
  select count(*) into v_service_role_execute from information_schema.role_routine_grants
   where routine_schema = 'public'
     and routine_name in ('mark_notification_sent', 'revoke_push_subscription_by_id')
     and grantee = 'service_role' and privilege_type = 'EXECUTE';
  if v_authenticated_execute <> 0 then raise exception 'CASE FAILED: authenticated has a grant on a Phase 6.3 RPC'; end if;
  if v_anon_execute <> 0 then raise exception 'CASE FAILED: anon has a grant on a Phase 6.3 RPC'; end if;
  if v_service_role_execute <> 2 then raise exception 'CASE FAILED: service_role does not have exactly EXECUTE on both new RPCs (saw %)', v_service_role_execute; end if;
end $$;
do $$ begin raise notice 'CASE: grants on both new RPCs are EXECUTE-only for service_role — OK'; end $$;

do $$
begin
  raise notice 'NOTIFICATION DELIVERY ISOLATION OK';
end $$;

rollback;
