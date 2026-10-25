# Eli V2.1 — Plan for durable health and memory storage

This document is a migration plan only. Eli V2.1 does not move, rewrite, or
delete any current JSON data.

## Goal

Move the local JSON stores used for health logs, check-ins, reminders, and
long-term memory to durable storage without interrupting Telegram users or
changing payment, entitlement, Community, or Avatar metering behavior.

## Proposed phases

1. **Inventory and contracts**
   - Freeze the current JSON shapes and every read/write path.
   - Define versioned records with `user_id`, ISO timestamp, Sofia local date,
     source, and idempotency key where delivery or logging can be replayed.
   - Keep payment/entitlement tables and their callers out of scope.

2. **Add a durable repository behind a feature flag**
   - Create a storage interface for each domain: health events, check-ins,
     relationship memory, conversation memory, reminders, and coach delivery.
   - Add append-only delivery/event records for reminder and daily-coaching
     idempotency. Do not use local `lastSent`/`lastCoachDate` as the sole
     cross-process guarantee after the cutover.
   - Read from JSON by default; dual-write only after a backup and explicit
     approval.

3. **Backfill safely**
   - Export a timestamped, encrypted backup of each JSON file.
   - Run an idempotent importer in dry-run mode first, reporting record counts,
     invalid rows, and user totals without altering production data.
   - Run the approved import once with immutable source snapshots and an audit
     report. No production secret values belong in logs or reports.

4. **Verify and switch reads gradually**
   - Compare per-user counts and representative records between JSON and the
     durable store.
   - Enable durable reads for a small allowlist, retain JSON fallback, and
     observe delivery/logging metrics.
   - Expand only after rollback rehearsal and regression tests pass.

5. **Retire JSON only after a retention window**
   - Keep read-only JSON backups through the agreed retention period.
   - Remove dual-write and local-file reads only with a separate approval and
     documented rollback path.

## Required safeguards before migration

- Per-record idempotency for reminder and coaching deliveries.
- Atomic write/claim semantics for concurrent bot processes.
- Europe/Sofia local-day fields stored alongside UTC timestamps.
- Access control, audit logging, backup/restore test, and data-retention policy.
- Regression contracts proving Stripe Checkout, webhooks, entitlements,
  Community, and Avatar metering remain untouched.
