#!/usr/bin/env bash
# Two-connection regression for simultaneous confirmation (Phase 8: plan from the briefing).
#
# A. SAME PROPOSAL. Session 1 confirms a briefing proposal (two NEW tasks) and HOLDS its
#    transaction open; session 2 confirms the very same proposal while it is open. The proposal's
#    row lock must make session 2 WAIT, then find it already confirmed and be refused (P0002).
#    Asserts: exactly one session succeeds, session 2 really waited, the tasks exist exactly once,
#    exactly one 'ai' revision was added, and the proposal is confirmed once.
#
# B. SAME DAY, SAME BASE REVISION. Session 1 applies a change through the low-level primitive and
#    HOLDS its transaction open; session 2 does the same from the SAME base revision for a
#    different task. The day's plan row lock must serialize them: session 2 waits, then sees the
#    revision moved and is refused as stale (40001). Asserts: one success, one 40001, the loser's
#    task untouched, and exactly one new revision (previously both could race to the same
#    revision number).
#
# Usage (LOCAL scratch Postgres with every migration applied — never a remote project):
#   DB_URL=postgres://postgres@127.0.0.1:55432/app bash supabase/tests/concurrent_briefing_confirm.sh
set -euo pipefail
: "${DB_URL:?set DB_URL to a LOCAL scratch database}"
PSQL=(psql "$DB_URL" -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -q -At)
UID_="$("${PSQL[@]}" -c 'select gen_random_uuid()')"
OUT="$(mktemp -d)"
cleanup() { "${PSQL[@]}" -c "delete from auth.users where id = '$UID_'" >/dev/null 2>&1 || true; rm -rf "$OUT"; }
trap cleanup EXIT

AS_USER="set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub','$UID_','role','authenticated')::text, true);"

# A fixture user whose local time is 12:xx right now, so every window below is inside the local day.
SETUP="$("${PSQL[@]}" <<SQL
insert into auth.users (id, aud, role, email, encrypted_password, created_at, updated_at)
values ('$UID_', 'authenticated', 'authenticated', 'p8-concurrent-$UID_@example.test', '', now(), now());
begin;
$AS_USER
insert into public.profiles (id, timezone)
select '$UID_', 'Etc/GMT' || case when n = 0 then '' when n > 0 then '+' || n else '-' || abs(n) end
  from (select extract(hour from now() at time zone 'UTC')::int - 12 as n) s;
select id from public.ensure_day();
commit;
SQL
)"
DAY_ID="$(echo "$SETUP" | tail -1)"
H="$("${PSQL[@]}" -c "select date_trunc('hour', now() at time zone 'UTC') at time zone 'UTC'")"

call_as_user() { # $1 = SQL to run inside a held-open transaction, $2 = seconds to hold before commit
  cat <<SQL
begin;
$AS_USER
$1;
select pg_sleep($2);
commit;
SQL
}

fail() { echo "FAIL: $1"; for f in "$OUT"/*; do echo "--- $(basename "$f")"; cat "$f"; done; exit 1; }
count() { "${PSQL[@]}" -c "$1"; }

# ── fixtures: a briefing, two movable tasks, and a pending briefing proposal with two creations ──
PROP_ID="$("${PSQL[@]}" <<SQL | tail -1
begin;
$AS_USER
insert into public.briefings (user_id, day_id, raw_text) values ('$UID_', '$DAY_ID', 'plan it');
select id as _ from public.create_task_with_history('$DAY_ID', 'Move me A', null, 'medium', 'flexible',
  '$H'::timestamptz + interval '3 hours', '$H'::timestamptz + interval '4 hours', null, 'user');
select id as _ from public.create_task_with_history('$DAY_ID', 'Move me B', null, 'medium', 'flexible',
  '$H'::timestamptz + interval '5 hours', '$H'::timestamptz + interval '6 hours', null, 'user');
select (public.create_ai_proposal('$DAY_ID', 1, 'typed', 'Plan my day', 'ok', '[]',
  jsonb_build_array(
    jsonb_build_object('ref','n1','type','create','title','Race one','start','$H'::timestamptz + interval '8 hours',
      'duration_minutes',30,'priority','medium','kind','flexible'),
    jsonb_build_object('ref','n2','type','create','title','Race two','start','$H'::timestamptz + interval '9 hours',
      'duration_minutes',30,'priority','low','kind','optional')),
  '[]', '[]', 'valid', (select id from public.briefings where day_id = '$DAY_ID'))).id;
commit;
SQL
)"
TASK_A="$(count "select id from public.tasks where day_id = '$DAY_ID' and title = 'Move me A'")"
TASK_B="$(count "select id from public.tasks where day_id = '$DAY_ID' and title = 'Move me B'")"

# ── A. the same proposal, confirmed from two connections at once ────────────────────────────────
CONFIRM="select public.confirm_ai_proposal_by_id('$PROP_ID')"
(call_as_user "$CONFIRM" 4 | "${PSQL[@]}" >"$OUT/a-s1.out" 2>"$OUT/a-s1.err") &
S1=$!
sleep 1.5
set +e
T0=$(date +%s)
call_as_user "$CONFIRM" 0 | "${PSQL[@]}" >"$OUT/a-s2.out" 2>"$OUT/a-s2.err"
S2_RC=${PIPESTATUS[1]}
WAITED=$(( $(date +%s) - T0 ))
wait "$S1"; S1_RC=$?
set -e

[ "$S1_RC" -eq 0 ] || fail "A: session 1 (the first confirmation) errored"
[ "$S2_RC" -ne 0 ] || fail "A: session 2 (the SAME proposal, concurrently) succeeded — double confirmation"
grep -q "P0002" "$OUT/a-s2.err" || fail "A: session 2 was refused for the wrong reason (expected P0002)"
[ "$WAITED" -ge 2 ] || fail "A: session 2 did not wait for session 1's lock (waited ${WAITED}s)"
[ "$(count "select count(*) from public.tasks where day_id = '$DAY_ID' and source = 'planner'")" = "2" ] \
  || fail "A: expected exactly 2 planner tasks"
[ "$(count "select count(*) from public.plan_revisions r join public.plans p on p.id = r.plan_id where p.day_id = '$DAY_ID' and r.source = 'ai'")" = "1" ] \
  || fail "A: expected exactly one ai revision"
[ "$(count "select count(*) from public.task_history h join public.tasks t on t.id = h.task_id where t.day_id = '$DAY_ID' and h.event = 'created' and h.source = 'ai'")" = "2" ] \
  || fail "A: expected exactly two created/ai history rows"
[ "$(count "select status from public.ai_proposals where id = '$PROP_ID'")" = "confirmed" ] \
  || fail "A: proposal not confirmed exactly once"
echo "A OK: the second confirmation waited (${WAITED}s) and was refused; 2 tasks, 1 ai revision, 1 confirmation"

# ── B. two different changes from the same base revision (the day's plan lock) ──────────────────
BASE="$(count "select max(r.revision_number) from public.plan_revisions r join public.plans p on p.id = r.plan_id where p.day_id = '$DAY_ID'")"
MOVE_A="select public.confirm_ai_proposal('$DAY_ID', $BASE, jsonb_build_array(jsonb_build_object('ref','t1','task_id','$TASK_A','type','move','new_start','$H'::timestamptz + interval '2 hours')))"
MOVE_B="select public.confirm_ai_proposal('$DAY_ID', $BASE, jsonb_build_array(jsonb_build_object('ref','t1','task_id','$TASK_B','type','move','new_start','$H'::timestamptz + interval '10 hours')))"
(call_as_user "$MOVE_A" 4 | "${PSQL[@]}" >"$OUT/b-s1.out" 2>"$OUT/b-s1.err") &
S1=$!
sleep 1.5
set +e
T0=$(date +%s)
call_as_user "$MOVE_B" 0 | "${PSQL[@]}" >"$OUT/b-s2.out" 2>"$OUT/b-s2.err"
S2_RC=${PIPESTATUS[1]}
WAITED=$(( $(date +%s) - T0 ))
wait "$S1"; S1_RC=$?
set -e

[ "$S1_RC" -eq 0 ] || fail "B: session 1 errored"
[ "$S2_RC" -ne 0 ] || fail "B: session 2 succeeded from a stale base revision"
grep -q "40001" "$OUT/b-s2.err" || fail "B: session 2 was refused for the wrong reason (expected 40001)"
[ "$WAITED" -ge 2 ] || fail "B: session 2 did not wait for the plan lock (waited ${WAITED}s)"
[ "$(count "select (scheduled_start = '$H'::timestamptz + interval '5 hours')::text from public.tasks where id = '$TASK_B'")" = "true" ] \
  || fail "B: the losing session's task was moved"
[ "$(count "select max(r.revision_number) from public.plan_revisions r join public.plans p on p.id = r.plan_id where p.day_id = '$DAY_ID'")" = "$((BASE + 1))" ] \
  || fail "B: expected exactly one new revision"
echo "B OK: the second change waited (${WAITED}s) and was refused as stale (40001); one new revision"

echo "CONCURRENT BRIEFING CONFIRM OK: replay race and same-day race both safe"
