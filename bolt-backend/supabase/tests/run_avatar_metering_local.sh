#!/usr/bin/env bash
# Disposable, socket-only PostgreSQL. Never points at a remote database.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d /tmp/avatar-metering-XXXXXX)"
trap 'pg_ctl -D "$work/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE PGOPTIONS
initdb -D "$work/data" -A trust --no-instructions >/dev/null
mkdir "$work/socket"
pg_ctl -D "$work/data" -o "-k $work/socket -p 55443 -c listen_addresses=''" -l "$work/log" start >/dev/null
sql() { psql -X -q -h "$work/socket" -p 55443 -U "$(id -un)" -d postgres -v ON_ERROR_STOP=1 "$@"; }
sql <<'SQL'
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE public.entitlements (
 telegram_user_id bigint PRIMARY KEY, plan_id text,status text,
 billing_status text,starts_at timestamptz,
 current_period_start timestamptz,current_period_end timestamptz,
 expires_at timestamptz
);
CREATE TABLE public.avatar_usage_events (
 id uuid DEFAULT gen_random_uuid() PRIMARY KEY, telegram_user_id bigint NOT NULL,
 request_id text UNIQUE NOT NULL, duration_seconds integer NOT NULL,
 period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,
 included_seconds_charged integer NOT NULL,addon_seconds_charged integer NOT NULL,
 CHECK(included_seconds_charged+addon_seconds_charged=duration_seconds)
);
CREATE TABLE public.avatar_addon_balances (
 telegram_user_id bigint PRIMARY KEY CHECK (telegram_user_id>0),
 purchased_seconds integer NOT NULL DEFAULT 0 CHECK (purchased_seconds>=0),
 used_seconds integer NOT NULL DEFAULT 0 CHECK (used_seconds>=0 AND used_seconds<=purchased_seconds),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
SQL
sql -f "$dir/../migrations/20260928150000_avatar_metering_reservations.sql"
sql <<'SQL'
-- A live-style pre-migration pending job must retain its included-only funding.
INSERT INTO public.avatar_generation_reservations
 (request_id,telegram_user_id,plan_id,period_start,period_end,status)
 VALUES('legacy-preserved-1',920000001,'monthly',now()-interval '1 day',now()+interval '1 day','uncertain');
INSERT INTO public.avatar_addon_balances(telegram_user_id,purchased_seconds,used_seconds)
 VALUES(920000001,100,12);
SQL
sql -f "$dir/../migrations/20261001120000_avatar_addon_reservations.sql"
sql <<'SQL'
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.avatar_generation_reservations
   WHERE request_id='legacy-preserved-1' AND status='uncertain' AND held_included_seconds=30 AND held_addon_seconds=0)
   OR NOT EXISTS(SELECT 1 FROM public.avatar_addon_balances
   WHERE telegram_user_id=920000001 AND purchased_seconds=100 AND used_seconds=12)
 THEN RAISE EXCEPTION 'migration changed existing data'; END IF;
 RAISE NOTICE 'PASS: migration preserves existing uncertain hold and purchased/used balances';
END $$;
SQL
sql -f "$dir/avatar_metering_local.sql"
sql -f "$dir/avatar_addon_local.sql"

# Real simultaneous sessions, not sequential calls labelled "concurrent".
# With exactly 30 global add-on seconds only one reservation can win.
for n in 1 2; do
  sql -c "SELECT public.avatar_reserve(910000050,'tg:910000050:$n')" \
    >"$work/reserve-$n" 2>&1 &
done
wait
test "$(grep -l 'reserved' "$work"/reserve-* | wc -l)" -eq 1
test "$(grep -l 'avatar_quota_exceeded' "$work"/reserve-* | wc -l)" -eq 1
echo 'PASS: concurrent reservations have exactly one winner'

# A direct legacy recorder and reservation race for the same 30 add-on seconds.
sql -c "SELECT public.avatar_reserve(910000051,'tg:910000051:1')" >"$work/race-reserve" 2>&1 &
sql -c "SELECT public.record_avatar_usage(910000051,'direct-race-51',30,current_period_start,current_period_end,1800) FROM public.entitlements WHERE telegram_user_id=910000051" >"$work/race-record" 2>&1 &
wait
test "$(grep -l 'avatar_quota_exceeded' "$work"/race-* | wc -l)" -eq 1
test "$(sql -Atc "SELECT COALESCE((SELECT sum(held_addon_seconds) FROM public.avatar_generation_reservations WHERE telegram_user_id=910000051 AND status='reserved'),0)+(SELECT used_seconds FROM public.avatar_addon_balances WHERE telegram_user_id=910000051)")" -eq 30
echo 'PASS: concurrent direct usage cannot spend held add-on funds'

# Two completion attempts debit once, even in separate database sessions.
for n in 1 2; do
  sql -c "SELECT public.avatar_transition(910000052,'tg:910000052:1','complete',NULL,12,'https://cdn.example/52.mp4')" >"$work/complete-$n" 2>&1 &
done
wait
test "$(grep -l 'settled' "$work"/complete-* | wc -l)" -eq 2
test "$(sql -Atc 'SELECT used_seconds FROM public.avatar_addon_balances WHERE telegram_user_id=910000052')" -eq 12
test "$(sql -Atc "SELECT count(*) FROM public.avatar_usage_events WHERE request_id='tg:910000052:1'")" -eq 1
echo 'PASS: concurrent completion debits once'