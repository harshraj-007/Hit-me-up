#!/usr/bin/env bash
# Database verification gate: from an EMPTY database, apply every migration in lexical order and run
# every committed SQL suite and every committed concurrency script. Fails (non-zero) on ANY failure,
# after running everything so one run reports all of them.
#
#   PG_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bash supabase/tests/run-all.sh
#
# PG_ADMIN_URL must point at a LOCAL, disposable Postgres (a superuser, database `postgres`). The
# script creates a throwaway database on it, applies supabase/tests/support/bootstrap.sql (the
# Supabase-shaped roles and default privileges — see that file) and then every migration, and drops
# the database again on exit. It needs no Supabase, Anthropic, Vercel or push credentials and refuses
# a non-local host so it can never touch a real project.
set -uo pipefail

: "${PG_ADMIN_URL:?set PG_ADMIN_URL to a LOCAL disposable Postgres, e.g. postgres://postgres:postgres@127.0.0.1:5432/postgres}"
case "$PG_ADMIN_URL" in
  *@127.0.0.1[:/]* | *@localhost[:/]* | *@\[::1\][:/]*) ;;
  *) echo "refusing: PG_ADMIN_URL must point at a local database (127.0.0.1 / localhost / ::1)"; exit 2 ;;
esac
case "$PG_ADMIN_URL" in
  */postgres | */postgres\?*) ;;
  *) echo "refusing: PG_ADMIN_URL must name the 'postgres' maintenance database (…/postgres)"; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="hitmeup_verify_$$_$RANDOM"
ADMIN=(psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -q -At)
DB_URL="$(printf '%s' "$PG_ADMIN_URL" | sed -E "s#/postgres(\?.*)?\$#/$DB\1#")"

"${ADMIN[@]}" -c "create database $DB" || { echo "could not create the scratch database"; exit 2; }
cleanup() { "${ADMIN[@]}" -c "drop database if exists $DB with (force)" >/dev/null 2>&1 || true; }
trap cleanup EXIT

run() { psql "$DB_URL" -v ON_ERROR_STOP=1 -q "$@"; }
FAILED=()

echo "── bootstrap (Supabase-shaped roles, auth schema, default privileges)"
run -f "$ROOT/supabase/tests/support/bootstrap.sql" >/dev/null || { echo "bootstrap failed"; exit 1; }

echo "── migrations (lexical order, from an empty database)"
MIGRATIONS=()
while IFS= read -r f; do MIGRATIONS+=("$f"); done < <(LC_ALL=C ls "$ROOT"/supabase/migrations/*.sql | LC_ALL=C sort)
[ "${#MIGRATIONS[@]}" -gt 0 ] || { echo "no migrations found"; exit 1; }
for f in "${MIGRATIONS[@]}"; do
  if out="$(run -f "$f" 2>&1)"; then echo "  ok    $(basename "$f")"; else
    echo "  FAIL  $(basename "$f")"; echo "$out" | tail -5; echo "a migration failed; nothing after it can be trusted"; exit 1
  fi
done

echo "── SQL suites"
SUITES=()
while IFS= read -r f; do SUITES+=("$f"); done < <(LC_ALL=C ls "$ROOT"/supabase/tests/*.sql 2>/dev/null | LC_ALL=C sort)
[ "${#SUITES[@]}" -gt 0 ] || { echo "no SQL suites found"; exit 1; }
for f in "${SUITES[@]}"; do
  if out="$(run -f "$f" 2>&1)"; then
    echo "  ok    $(basename "$f")  ($(echo "$out" | grep -c ' OK') checks)"
  else
    echo "  FAIL  $(basename "$f")"; echo "$out" | grep -E "ERROR|FAILED|CONTEXT" | head -8; FAILED+=("$(basename "$f")")
  fi
done

echo "── concurrency scripts (real parallel connections)"
SCRIPTS=()
while IFS= read -r f; do SCRIPTS+=("$f"); done < <(LC_ALL=C ls "$ROOT"/supabase/tests/concurrent_*.sh 2>/dev/null | LC_ALL=C sort)
[ "${#SCRIPTS[@]}" -gt 0 ] || { echo "no concurrency scripts found"; exit 1; }
for f in "${SCRIPTS[@]}"; do
  if out="$(DB_URL="$DB_URL" bash "$f" 2>&1)"; then echo "  ok    $(basename "$f")"; else
    echo "  FAIL  $(basename "$f")"; echo "$out" | tail -8; FAILED+=("$(basename "$f")")
  fi
done

echo
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "DATABASE VERIFICATION FAILED: ${FAILED[*]}"; exit 1
fi
echo "DATABASE VERIFICATION OK: ${#MIGRATIONS[@]} migrations, ${#SUITES[@]} SQL suites, ${#SCRIPTS[@]} concurrency scripts"
