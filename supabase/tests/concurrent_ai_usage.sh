#!/usr/bin/env bash
# Two-connection / many-connection regression for the AI usage limit (reserve_ai_call).
#
# A. HOLD-OPEN. Session 1 reserves the LAST free slot and HOLDS its transaction open; session 2 asks
#    for a slot while it is open. The per-user advisory lock must make session 2 WAIT, then count
#    session 1's reservation and be refused. Asserts: session 2 really waited, exactly one was
#    allowed, and the ceiling was not exceeded.
#
# B. RACE. N sessions all fire at the same instant (a shared start time) against a budget with K
#    free slots. Without the lock each would read "K free" and all take one; with it exactly K are
#    allowed. Asserts: allowed == K, refused == N - K, and exactly K events were written.
#
# The ceilings are set for the run and RESTORED on exit. Usage (LOCAL scratch Postgres with every
# migration applied — never a remote project):
#   DB_URL=postgres://postgres@127.0.0.1:55432/app bash supabase/tests/concurrent_ai_usage.sh
set -euo pipefail
: "${DB_URL:?set DB_URL to a LOCAL scratch database}"
PSQL=(psql "$DB_URL" -v ON_ERROR_STOP=1 -q -At)
UID_="$("${PSQL[@]}" -c 'select gen_random_uuid()')"
OUT="$(mktemp -d)"
ORIG="$("${PSQL[@]}" -F ' ' -c 'select hourly_limit, daily_limit from public.ai_usage_limits')"
ORIG_H="${ORIG% *}"; ORIG_D="${ORIG#* }"
cleanup() {
  "${PSQL[@]}" -c "update public.ai_usage_limits set hourly_limit = $ORIG_H, daily_limit = $ORIG_D" >/dev/null 2>&1 || true
  "${PSQL[@]}" -c "delete from auth.users where id = '$UID_'" >/dev/null 2>&1 || true
  rm -rf "$OUT"
}
trap cleanup EXIT

"${PSQL[@]}" -c "insert into auth.users (id, aud, role, email, encrypted_password, created_at, updated_at)
  values ('$UID_', 'authenticated', 'authenticated', 'usage-concurrent-$UID_@example.test', '', now(), now())" >/dev/null

AS_USER="set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub','$UID_','role','authenticated')::text, true);"
events() { "${PSQL[@]}" -c "select count(*) from public.ai_usage_events where user_id = '$UID_'"; }
fail() { echo "FAIL: $1"; for f in "$OUT"/*; do echo "--- $(basename "$f")"; cat "$f"; done; exit 1; }

# ── A. hold-open ────────────────────────────────────────────────────────────────────────────────
"${PSQL[@]}" -c "update public.ai_usage_limits set hourly_limit = 3, daily_limit = 100" >/dev/null
"${PSQL[@]}" -c "insert into public.ai_usage_events (user_id, feature) select '$UID_', 'plan' from generate_series(1, 2)" >/dev/null

(
  "${PSQL[@]}" >"$OUT/a-s1.out" 2>"$OUT/a-s1.err" <<SQL
begin;
$AS_USER
select public.reserve_ai_call('plan') ->> 'allowed';
select pg_sleep(4);
commit;
SQL
) &
S1=$!
sleep 1.5
set +e
T0=$(date +%s)
"${PSQL[@]}" >"$OUT/a-s2.out" 2>"$OUT/a-s2.err" <<SQL
begin;
$AS_USER
select public.reserve_ai_call('briefing_plan') ->> 'allowed';
commit;
SQL
S2_RC=$?
WAITED=$(( $(date +%s) - T0 ))
wait "$S1"; S1_RC=$?
set -e

[ "$S1_RC" -eq 0 ] && [ "$S2_RC" -eq 0 ] || fail "A: a session errored"
grep -q '^true$' "$OUT/a-s1.out" || fail "A: session 1 (the last free slot) was not allowed"
grep -q '^false$' "$OUT/a-s2.out" || fail "A: session 2 got through although the budget was spent"
[ "$WAITED" -ge 2 ] || fail "A: session 2 did not wait for session 1's lock (waited ${WAITED}s)"
[ "$(events)" = "3" ] || fail "A: expected exactly 3 events (the ceiling), found $(events)"
echo "A OK: the second reservation waited (${WAITED}s), was refused, and the ceiling held"

# ── B. race ─────────────────────────────────────────────────────────────────────────────────────
N=12; K=5
"${PSQL[@]}" -c "delete from public.ai_usage_events where user_id = '$UID_'" >/dev/null
"${PSQL[@]}" -c "update public.ai_usage_limits set hourly_limit = $K, daily_limit = 100" >/dev/null
START="$("${PSQL[@]}" -c "select clock_timestamp() + interval '3 seconds'")"
for i in $(seq 1 $N); do
  (
    "${PSQL[@]}" >"$OUT/b-$i.out" 2>"$OUT/b-$i.err" <<SQL
begin;
$AS_USER
select pg_sleep(greatest(0, extract(epoch from ('$START'::timestamptz - clock_timestamp()))));
select public.reserve_ai_call('plan') ->> 'allowed';
commit;
SQL
  ) &
done
wait
ALLOWED=$(cat "$OUT"/b-*.out | grep -c '^true$' || true)
REFUSED=$(cat "$OUT"/b-*.out | grep -c '^false$' || true)
[ "$ALLOWED" -eq "$K" ] || fail "B: expected exactly $K allowed, got $ALLOWED (refused $REFUSED) — the ceiling was overshot"
[ "$REFUSED" -eq $((N - K)) ] || fail "B: expected $((N - K)) refused, got $REFUSED"
[ "$(events)" = "$K" ] || fail "B: expected exactly $K events written, found $(events)"
echo "B OK: $N simultaneous requests, $K slots: exactly $ALLOWED allowed, $REFUSED refused, $K events written"

echo "CONCURRENT AI USAGE OK: the advisory lock serializes check-and-reserve"
