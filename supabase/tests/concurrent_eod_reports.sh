#!/usr/bin/env bash
# Two-connection regression for simultaneous end-of-day report creation (Phase 7).
#
# Session 1 creates a report for a day-state and HOLDS its transaction open; session 2 asks for the
# same (day, fingerprint) while it is open. The unique constraint makes the second insert wait,
# then a no-op; create_eod_report() must then return the winner's row. Asserts: neither session
# errors, exactly one row exists, and both sessions were handed the SAME report id.
#
# Usage (LOCAL scratch Postgres with every migration applied — never a remote project):
#   DB_URL=postgres://postgres@127.0.0.1:55432/app bash supabase/tests/concurrent_eod_reports.sh
set -euo pipefail
: "${DB_URL:?set DB_URL to a LOCAL scratch database}"
PSQL=(psql "$DB_URL" -v ON_ERROR_STOP=1 -q -At)
UID_="$("${PSQL[@]}" -c 'select gen_random_uuid()')"
OUT="$(mktemp -d)"
cleanup() { "${PSQL[@]}" -c "delete from auth.users where id = '$UID_'" >/dev/null 2>&1 || true; rm -rf "$OUT"; }
trap cleanup EXIT

DAY_ID="$("${PSQL[@]}" <<SQL
insert into auth.users (id, aud, role, email, encrypted_password, created_at, updated_at)
values ('$UID_', 'authenticated', 'authenticated', 'eod-concurrent-$UID_@example.test', '', now(), now());
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','$UID_','role','authenticated')::text, true);
insert into public.profiles (id, timezone) values ('$UID_', 'UTC');
select id from public.ensure_day();
commit;
SQL
)"
DAY_ID="$(echo "$DAY_ID" | tail -1)"
LOCAL_DATE="$("${PSQL[@]}" -c "select local_date from public.days where id = '$DAY_ID'")"
FACTS="{\"planningDate\":\"$LOCAL_DATE\",\"timezone\":\"UTC\",\"asOf\":\"${LOCAL_DATE}T21:00\",\"tasks\":[{\"ref\":\"t1\",\"title\":\"x\"}],\"totals\":{\"total\":1}}"
INTERP='{"summary":"s","takeaway":"t","patterns":[],"carryForward":[]}'
FP="$(printf 'c%.0s' $(seq 1 64))"
CALL="select id from public.create_eod_report('$DAY_ID', '$FP', 'v1', '$FACTS'::jsonb, '$INTERP'::jsonb)"

(
  "${PSQL[@]}" >"$OUT/s1.out" 2>"$OUT/s1.err" <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','$UID_','role','authenticated')::text, true);
$CALL;
select pg_sleep(4);
commit;
SQL
) &
S1=$!
sleep 1.5
set +e
"${PSQL[@]}" >"$OUT/s2.out" 2>"$OUT/s2.err" <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','$UID_','role','authenticated')::text, true);
$CALL;
commit;
SQL
S2_RC=$?
wait "$S1"; S1_RC=$?
set -e

fail() { echo "FAIL: $1"; echo "--- s1.err"; cat "$OUT/s1.err"; echo "--- s2.err"; cat "$OUT/s2.err"; exit 1; }
[ "$S1_RC" -eq 0 ] || fail "session 1 errored"
[ "$S2_RC" -eq 0 ] || fail "session 2 (simultaneous identical request) errored"
ROWS="$("${PSQL[@]}" -c "select count(*) from public.eod_reports where day_id = '$DAY_ID'")"
[ "$ROWS" = "1" ] || fail "expected exactly 1 report, found $ROWS"
ID1="$(grep -E '^[0-9a-f-]{36}$' "$OUT/s1.out" | head -1)"; ID2="$(grep -E '^[0-9a-f-]{36}$' "$OUT/s2.out" | head -1)"
[ -n "$ID1" ] && [ "$ID1" = "$ID2" ] || fail "sessions got different report ids ($ID1 vs $ID2)"
echo "CONCURRENT EOD REPORTS OK: no error, one row, both sessions returned the same report"
