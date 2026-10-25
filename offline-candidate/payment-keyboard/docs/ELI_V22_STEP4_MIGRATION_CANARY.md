# Eli V2.2 Step 4 — Migration & Canary Foundation

This step is preparation only. It must not activate production migration, durable reads, dual-write, Supabase deployment, or bot restart.

## Legacy JSON inventory

| Domain | Legacy source |
|---|---|
| User health profile | bot/users.json via storage.js |
| General long-term memory and conversation history | bot/user_memory.json via memoryStorage.js, override USER_MEMORY_PATH |
| Relationship memory | bot/relationship_memory.json via relationshipMemoryStorage.js, override RELATIONSHIP_MEMORY_PATH |
| Health logs/events | bot/daily_logs.json via dailyLogStorage.js, override DAILY_LOG_PATH |
| Check-ins | bot/daily_progress.json via checkinStorage.js |
| Reminders | bot/reminders.json via reminderStorage.js |
| Conversation freshness / short-term state | bot/conversation_state.json via conversationState.js |

Owner identity is code-backed in ownerContext.js and is not part of this user-data migration.

## Rules

1. Backup every legacy JSON file first and produce a SHA-256 manifest.
2. Dry-run importer is write-disabled and operates on supplied copies/fixtures only.
3. Reconciliation is grouped by Telegram user ID.
4. Invalid/skipped/conflicting rows are reported, never silently repaired.
5. Canary durable reads require an explicit Telegram ID allowlist.
6. Legacy JSON remains source of truth and fallback.
7. Any durable error or mismatch returns legacy data and emits diagnostics only.
8. No automated delete, overwrite, dual-write, deployment, or restart is permitted in Step 4.

## Restore

Restore the exact backed-up JSON files whose SHA-256 values match the saved manifest, disable V2.2 durable/canary flags, and restart only after separate operator approval.
