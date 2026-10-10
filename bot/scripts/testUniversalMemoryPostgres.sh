#!/usr/bin/env bash
set -euo pipefail
# Requires a fresh disposable database with no production credentials.
test "${ELI_MEMORY_DISPOSABLE_DATABASE:-}" = "1"
task_dir="$(mktemp -d)"
trap 'rm -rf "$task_dir"' EXIT
psql -X -v ON_ERROR_STOP=1 -f test/universalMemoryPostgres.sql
race_sql="SET ROLE service_role; SELECT public.eli_memory_compare_and_swap('99000000000000000001', 2, '{\"version\":1,\"iv\":\"synthetic\",\"tag\":\"synthetic\",\"ciphertext\":\"synthetic\"}'::jsonb);"
psql -X -tA -v ON_ERROR_STOP=1 -c "$race_sql" > "$task_dir/a" &
task_pid_a=$!
psql -X -tA -v ON_ERROR_STOP=1 -c "$race_sql" > "$task_dir/b" &
task_pid_b=$!
wait "$task_pid_a"
wait "$task_pid_b"
# SET emits a command tag, NULL emits a blank line. Count only the winning revision.
task_winners="$(cat "$task_dir/a" "$task_dir/b" | awk '$0 == "3" {n++} END {print n+0}')"
test "$task_winners" = "1"
echo 'postgres-concurrency-ok'
