# Eli V2.2 Durable Memory Rollout

Status: local development preparation only. CRUD client/service code and an
Edge Function scaffold are present, but no production migration, import,
deployment, durable read activation, dual-write, bot restart, or main merge is
authorized by this document.

## Durable entities

- eli_user_health_profiles
- eli_memory_facts
- eli_health_events
- eli_checkins
- eli_short_context
- eli_reminders
- eli_scheduled_deliveries

Every user-scoped row is keyed by telegram_user_id. Short context is bounded to 10 messages and must expire no later than 24 hours after refresh. Health events are append-only. Delivery claims use an idempotency key and lease.

The `eli-memory` function is deliberately limited to `eli_memory_facts`; it
does not return health events or profile/context rows. Its local deployment
contract and required secret names are documented in
`bolt-backend/supabase/functions/eli-memory/README.md`. Owner durable flags
remain off unless the matching explicit environment flag is set and an
authenticated `/health` response for the approved project and contract was
verified within 30 seconds.

## Safe migration sequence

1. Copy all legacy JSON files without modifying them.
2. Produce SHA-256 checksums and row counts for every source.
3. Run the importer in dry-run mode against fixtures/test storage only.
4. Reconcile counts and values per Telegram user ID.
5. Apply schema only after separate approval.
6. Enable durable reads only for an explicit Telegram-ID allowlist.
7. Keep legacy JSON as fallback/source of truth during canary.
8. Consider dual-write only as a separately approved phase.
9. Retire JSON only after a separate reconciliation and rollback review.

## Rollback

Disable all Eli V2.2 durable flags. The current JSON path remains intact. Because this foundation performs no production import or write, rollback requires no data mutation.
