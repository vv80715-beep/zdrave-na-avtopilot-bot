#!/usr/bin/env bash
# Disposable, socket-only PostgreSQL test. Never connects to an existing DB.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
migration="$script_dir/../migrations/20260928120000_entitlement_expiry_outbox.sql"
work="$(mktemp -d /tmp/expiry-sql-test-XXXXXX)"
cleanup() {
  pg_ctl -D "$work/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# Explicit socket and database arguments below override ambient libpq settings.
unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE PGOPTIONS
initdb -D "$work/data" -A trust --no-instructions >/dev/null
mkdir "$work/socket"
pg_ctl -D "$work/data" \
  -o "-k $work/socket -p 55439 -c listen_addresses=''" \
  -l "$work/postgres.log" start >/dev/null
sql() {
  psql -X -h "$work/socket" -p 55439 -U "$(id -un)" -d postgres \
    -v ON_ERROR_STOP=1 "$@"
}

sql -q <<'SQL'
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
-- Only the columns referenced by this migration, in a disposable local DB.
CREATE TABLE public.entitlements (
  telegram_user_id bigint PRIMARY KEY,
  plan_id text NOT NULL,
  status text NOT NULL,
  billing_status text NOT NULL,
  starts_at timestamptz NOT NULL,
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.avatar_addon_balances (
  telegram_user_id bigint PRIMARY KEY,
  purchased_seconds bigint NOT NULL,
  used_seconds bigint NOT NULL
);
SQL

# pg_cron is not bundled with this local PG16 installation. Remove only its
# installation and scheduling statements; all other production SQL runs as-is.
echo "Local test: pg_cron extension and cron.schedule mocked by omission (no scheduler)."
awk '
  /^CREATE EXTENSION IF NOT EXISTS pg_cron/ { next }
  /^SELECT cron.schedule\(/ { skipping = 1; next }
  skipping && /^\);/ { skipping = 0; next }
  !skipping { print }
' "$migration" > "$work/migration-without-local-cron.sql"
sql -q -f "$work/migration-without-local-cron.sql"
sql -q -f "$script_dir/entitlement_expiry_local.sql"