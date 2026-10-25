#!/usr/bin/env bash
# Isolated test DB only. Never uses project credentials/remote DB or workflows.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d /tmp/addon-notice-test-XXXXXX)"
trap 'pg_ctl -D "$work/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSWORD PGPASSFILE
initdb -D "$work/data" -U postgres -A trust --no-instructions >/dev/null
mkdir "$work/socket"
pg_ctl -D "$work/data" -o "-k $work/socket -p 55449 -c listen_addresses=''" -l "$work/server.log" start >/dev/null
sql() { psql -X -q -h "$work/socket" -p 55449 -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
node "$dir/local-schema.mjs" | sql
sql -f "$dir/../baseline/credit_avatar_addon_purchase.sql"
sql -f "$dir/../baseline/claim_payment_notification.sql"
sql -f "$dir/../supabase/migrations/20261001150000_avatar_addon_notification.sql"
sql -f "$dir/database.sql"

# True concurrent SQL sessions racing to credit the same purchase.
pids=()
for n in 1 2; do
  sql -At -c "SELECT duplicate FROM credit_avatar_addon_purchase('bbbbbbbb-bbbb-4bbb-8bbb-000000000006','cs_local_6','pi_local_6','evt_concurrent_$n')" >"$work/credit-$n" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
test "$(cat "$work"/credit-* | grep -c '^f$')" -eq 1
test "$(cat "$work"/credit-* | grep -c '^t$')" -eq 1
test "$(sql -At -c 'SELECT purchased_seconds FROM avatar_addon_balances WHERE telegram_user_id=990000006')" = '1200'
echo 'PASS: concurrent credit has one winner and one balance increment'

# Hold the first claim transaction open while the second claims the SAME row.
event="$(sql -At -c 'SELECT id FROM payment_notification_outbox WHERE telegram_user_id=990000006')"
sql -At <<SQL >"$work/claim-1" &
BEGIN;
SELECT claim_payment_notification('$event')->>'status';
\! touch "$work/locked"
SELECT pg_sleep(1);
COMMIT;
SQL
pid="$!"
for n in $(seq 1 100); do test -f "$work/locked" && break; sleep .03; done
test -f "$work/locked"
test -z "$(sql -At -c "SELECT claim_payment_notification('$event')")"
wait "$pid"
test "$(grep -c '^sending$' "$work/claim-1")" -eq 1
test "$(sql -At -c "SELECT attempts FROM payment_notification_outbox WHERE id='$event'")" = 1
echo 'PASS: concurrent claim skips locked row; exactly one sending lease'