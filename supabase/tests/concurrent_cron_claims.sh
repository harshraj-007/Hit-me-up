#!/usr/bin/env bash
# Two-connection regression for overlapping cron invocations (Phase 6.2 + its Phase 6 follow-up).
#
# One transaction calls reconcile_and_claim_notifications() and HOLDS its locks open; a second
# invocation fires while it is still open. Single-session suites can't prove this — it needs two
# real connections. Asserts:
#   * neither invocation errors (the pre-fix defect: the second died with a unique violation on
#     scheduled_notifications_one_active_per_task_kind when both tried to create the same new
#     reminder);
#   * nothing is claimed twice: each fixture notification ends `claimed` with attempt_count = 1;
#   * exactly one active reminder exists per fixture task.
#
# Usage (against a throwaway/local Postgres with every migration applied — never a remote
# project):   DB_URL=postgres://postgres@127.0.0.1:55432/app bash supabase/tests/concurrent_cron_claims.sh
set -euo pipefail
: "${DB_URL:?set DB_URL to a LOCAL scratch database}"
PSQL=(psql "$DB_URL" -v ON_ERROR_STOP=1 -q -At)
UID_="$(${PSQL[@]} -c 'select gen_random_uuid()')"
OUT="$(mktemp -d)"
cleanup() { "${PSQL[@]}" -c "delete from auth.users where id = '$UID_'" >/dev/null 2>&1 || true; rm -rf "$OUT"; }
trap cleanup EXIT

"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, aud, role, email, encrypted_password, created_at, updated_at)
values ('$UID_', 'authenticated', 'authenticated', 'concurrent-$UID_@example.test', '', now(), now());
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','$UID_','role','authenticated')::text, true);
insert into public.profiles (id, timezone) values ('$UID_', 'UTC');
select * from public.ensure_day() \gset d_
select public.create_task_with_history(:'d_id','concurrent A',null,'medium','flexible', now()+interval '5 minutes', now()+interval '35 minutes', null,'user');
select public.create_task_with_history(:'d_id','concurrent B',null,'medium','flexible', now()+interval '6 minutes', now()+interval '36 minutes', null,'user');
commit;
SQL

# Session 1: claims, then holds its transaction (and every row/index lock it took) open.
(
  "${PSQL[@]}" >"$OUT/s1.out" 2>"$OUT/s1.err" <<SQL
begin;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select count(*) from public.reconcile_and_claim_notifications();
select pg_sleep(4);
commit;
SQL
) &
S1=$!
sleep 1.5

# Session 2: fires while session 1's transaction is open.
set +e
"${PSQL[@]}" >"$OUT/s2.out" 2>"$OUT/s2.err" <<SQL
begin;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select count(*) from public.reconcile_and_claim_notifications();
commit;
SQL
S2_RC=$?
wait "$S1"; S1_RC=$?
set -e

fail() { echo "FAIL: $1"; echo "--- s1.err"; cat "$OUT/s1.err"; echo "--- s2.err"; cat "$OUT/s2.err"; exit 1; }
[ "$S1_RC" -eq 0 ] || fail "session 1 errored"
[ "$S2_RC" -eq 0 ] || fail "session 2 (overlapping invocation) errored"

ROWS="$("${PSQL[@]}" -c "select status || ':' || attempt_count from public.scheduled_notifications where user_id = '$UID_' order by task_id")"
[ "$(echo "$ROWS" | sort | uniq -c | tr -s ' ')" = " 2 claimed:1" ] || fail "expected both notifications claimed exactly once, got: $ROWS"
ACTIVE="$("${PSQL[@]}" -c "select count(*) from public.scheduled_notifications where user_id = '$UID_' and status in ('scheduled','claimed')")"
[ "$ACTIVE" = "2" ] || fail "expected exactly 2 active reminders (one per task), got $ACTIVE"

echo "CONCURRENT CRON CLAIMS OK: no error, nothing claimed twice, one active reminder per task"
