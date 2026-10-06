-- ─────────────────────────────────────────────────────────────────────────
-- service_role boundary check (Phase 6 live-verification hardening).
--
-- A Supabase project grants service_role full default privileges on every new public table AND
-- function (`alter default privileges ... to anon, authenticated, service_role`). The cron path
-- holds the service-role key, so this proves what that key can and cannot do once every migration
-- is applied:
--   * it can EXECUTE exactly the three system RPCs and nothing else;
--   * every user-session RPC is not even EXECUTE-able by it, AND independently refuses it
--     (42501) via the function's own auth.uid() check — two separate layers;
--   * it can only SELECT the tables Phase 6.3's delivery reads, and cannot write them.
--
-- Run against a real Postgres whose roles mirror Supabase's (see the other files in this
-- directory for the setup), with every migration applied:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/service_role_boundary.sql
-- Everything runs in one transaction and is rolled back.
-- ─────────────────────────────────────────────────────────────────────────

begin;

do $$
declare
  r record;
  system_rpcs constant text[] := array[
    'reconcile_and_claim_notifications()',
    'mark_notification_sent(uuid)',
    'revoke_push_subscription_by_id(uuid)'
  ];
  n int := 0;
begin
  -- 1. EXECUTE grants: service_role holds exactly the system RPCs among all `public` functions
  --    (trigger function set_updated_at() cannot be invoked directly and is excluded).
  for r in
    select p.oid, p.oid::regprocedure::text as sig, p.prorettype::regtype::text as ret
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.prorettype <> 'trigger'::regtype
  loop
    if r.sig = any (system_rpcs) then
      if not has_function_privilege('service_role', r.oid, 'execute') then
        raise exception 'service_role LOST execute on system RPC %', r.sig;
      end if;
      if has_function_privilege('authenticated', r.oid, 'execute')
         or has_function_privilege('anon', r.oid, 'execute') then
        raise exception 'user role can execute system RPC %', r.sig;
      end if;
    else
      if has_function_privilege('service_role', r.oid, 'execute') then
        raise exception 'service_role can execute non-system function %', r.sig;
      end if;
    end if;
    n := n + 1;
  end loop;
  if n < 14 then raise exception 'expected at least 14 public functions, saw %', n; end if;
  raise notice 'CASE 1: service_role EXECUTE = exactly the 3 system RPCs, across % functions — OK', n;

  -- 2. Table privileges: service_role may only SELECT the three tables delivery reads, and holds
  --    no write privilege on any of the app's tables.
  for r in
    select c.oid, c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind = 'r'
  loop
    if has_table_privilege('service_role', r.oid, 'insert')
       or has_table_privilege('service_role', r.oid, 'update')
       or has_table_privilege('service_role', r.oid, 'delete')
       or has_table_privilege('service_role', r.oid, 'truncate') then
      raise exception 'service_role has a write privilege on public.%', r.relname;
    end if;
    if r.relname in ('tasks', 'push_subscriptions', 'scheduled_notifications') then
      if not has_table_privilege('service_role', r.oid, 'select') then
        raise exception 'service_role cannot read public.% (delivery needs it)', r.relname;
      end if;
    end if;
  end loop;
  raise notice 'CASE 2: service_role has no write privilege on any public table — OK';
end $$;

-- 3. Defense in depth, second layer: even bypassing the grant check (superuser), every
--    user-session RPC refuses a service_role JWT because its own auth.uid() is null.
do $$
declare
  r record;
  z uuid := '00000000-0000-0000-0000-000000000001';
  refused int := 0;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  for r in select * from (values
    ('ensure_day',                 'select public.ensure_day(null)'),
    ('create_task_with_history',   format($f$select public.create_task_with_history(%L,'x',null,'medium','flexible',now(),now()+interval '1 hour',null,'user')$f$, z)),
    ('change_task_status',         format($f$select public.change_task_status(%L,'completed')$f$, z)),
    ('reschedule_task',            format($f$select public.reschedule_task(%L,now(),now()+interval '1 hour')$f$, z)),
    ('apply_replan',               format($f$select public.apply_replan(%L,'[]'::jsonb)$f$, z)),
    ('confirm_ai_proposal',        format($f$select public.confirm_ai_proposal(%L,1,'[]'::jsonb)$f$, z)),
    ('confirm_ai_proposal_by_id',  format($f$select public.confirm_ai_proposal_by_id(%L)$f$, z)),
    ('create_ai_proposal',         format($f$select public.create_ai_proposal(%L,1,'typed','t','u','[]','[]','[]','[]','valid')$f$, z)),
    ('discard_ai_proposal',        format($f$select public.discard_ai_proposal(%L)$f$, z)),
    ('register_push_subscription', $f$select public.register_push_subscription('https://x.test/e','p','a')$f$),
    ('revoke_push_subscription',   $f$select public.revoke_push_subscription('https://x.test/e')$f$),
    ('reserve_ai_call',            $f$select public.reserve_ai_call('plan')$f$)
  ) as t(name, stmt) loop
    begin
      execute r.stmt;
      raise exception 'CASE 3 FAILED: % accepted a service_role JWT', r.name;
    exception when sqlstate '42501' then
      refused := refused + 1;
    end;
  end loop;
  if refused <> 12 then raise exception 'expected 12 refusals, saw %', refused; end if;
  raise notice 'CASE 3: all 12 user-session RPCs independently refuse a service_role JWT (42501) — OK';
end $$;

do $$ begin raise notice 'SERVICE ROLE BOUNDARY OK'; end $$;

rollback;
