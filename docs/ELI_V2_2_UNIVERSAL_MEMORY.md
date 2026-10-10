# Eli V2.2 universal personal memory

Status on 2026-10-10: **staged source; production activation is blocked**. The newer Replit source must be preserved and reconciled with this patch. Runtime Supabase credentials, the universal encryption secret, compatible legacy reconciliation, real PostgREST checks and Telegram rollout are not yet verified.

## Proven causes and source boundary

GitHub base `cd1d96f31e2bfbb333e50307f9d8460b410c82ad` contains fitness-oriented relationship/candidate handlers. Automated tests reproduce their refusal of the favorite-color request before persistence. The fresh Replit audit found a newer, unpublished HEAD, `c0f2341b1e4a08d5bf8c585940f5d11dd42c23cf`: its explicit-preference handler also misses the color wording and falls through to the restricted relationship classifier. This is an extraction/routing restriction, not evidence of a Supabase outage. Never replace the newer Replit checkout with this GitHub snapshot.

Controlled tests with the actual `gpt-4o-mini` model exposed two further generic faults in the first patch: broad topic labels merged independent facts, and recall/deletion generated unwanted write proposals. Commit `2553728` removes topic-only identity matching and separates selection from write schemas. Its final controlled run passed 15/15, but other runs failed and therefore did not establish release readiness.

Follow-up diagnosis reproduced `existing_id_not_in_scope`: the model invented or altered an existing UUID. Three of five controlled examples were rejected, and another full run failed after one such rejection. The current correction constrains provider schemas to this sender's actual IDs, distinguishes new/null from existing/same-or-changed records, and retains server-side membership validation. A repeated real-model check of the exact corrected source remains mandatory. Rejection is never converted into success or retried with a relaxed identity check.

## One logical source of truth

For exact canary senders, trusted Telegram sender identity selects one canonical encrypted state. Generic operation detection handles remembering, recall, update, deletion and explicit clear without enumerating fact categories. Polite command prefixes are supported. Ordinary facts of arbitrary topics are extracted with literal evidence; health reports remain in separate journals. Sensitive facts require fresh explicit consent from the same sender, tied to the unchanged revision and expiring after five minutes. Pending consent is RAM-only. Unsafe instructions, credentials and third-party private data are rejected.

Facts have stable UUIDs and timestamps. Semantic identity uses an existing ID, with an exact topic-and-value duplicate fallback; a broad topic label is only a display label. Multiple hobbies or plans can coexist. Contradictory values require an explicit update. Bounded idempotency receipts contain hashes, not incoming message text. Compare-and-swap prevents concurrent silent overwrites. Success is confirmed only after a fresh read matches the full expected state and revision.

Canary routing precedes legacy personal memory handlers and disables their passive personal capture, profile dumps and memory wizard. Show, forget, coaching and plans use the same canonical personal context. Legacy personal JSON is retained; journals, generated plans and administrative owner identity remain separate. Administrative commands cannot expose another sender's canonical private facts. Missing model, database, encryption or migration configuration fails closed, with no alternative unverified writer.

Normal canary private chats use a bounded RAM session instead of writing personal exchanges to legacy conversation files. Verified mutations clear that session. Group AI requests omit private canonical facts, owner memory and private session history; group exchanges never enter the private session. Even an empty or irrelevant memory context includes instructions against false claims of persistence. Relevant facts enter the AI prompt as JSON data with instructions against executing their contents. Broad profile recall reads verified state directly, avoiding unnecessary model uploads and large ID outputs.

Limits: 200 facts per sender, 800 characters per fact, eight extracted facts per write, eight context facts and 50 receipts. Summaries respect Telegram message size and invite specific recall when truncated. Limits and integrity failures produce visible failures.

## Persistence and schema

The SQL specification is staged, not applied. Production uses server-side Supabase PostgREST directly; existing Edge Functions remain untouched. The new table has RLS and revoked public/anon/authenticated permissions. The SECURITY INVOKER compare-and-swap function uses an empty search path and minimal server grants. No existing table or payment schema changes.

The filesystem repository is isolated-test-only. There is no production filesystem fallback. AES-256-GCM binds ciphertext to sender and revision. Configure a canonical base64 32-byte encryption secret and a protected independent recovery copy; never print or commit either it or a service-role key. Losing the key makes encrypted state and backups unrecoverable.

Read-only production inspection found PostgreSQL 17.6 and no memory table or memory Edge Function. Management-connector access does not establish runtime REST access. Replit's audit found OpenAI configured, but no runtime Supabase server credentials or universal encryption secret. No production schema migration or memory write has been made.

## Backup, reconciliation and rollback gates

A private encrypted backup of 19 current Replit files was verified stable and restored in an isolated environment: 19/19 SHA-256 matches; tampered ciphertext rejected before extraction. It contains legacy data and relevant owner/configuration/source material outside the checkout. The original archive is not directly compatible with the importer; a compatible verified archive and encrypted reconciliation plan are still required. No independent offsite archive/key recovery has been verified. Original files remain intact.

The migration utility preserves exact source bytes, including corrupt or invalid UTF-8 data, before failing. Format 2 stores raw base64 bytes inside encryption; old format-1 verified text backups remain readable. Exclusive output creation prevents overwriting an archive. Reconciliation never writes production data: ordinary historical facts can be semantically consolidated with explicitly authorized AI use; sensitive/unsafe records are held without model upload. Contradictions and unclear values are held for private resolution, and senders with held records cannot be imported. Full original values remain recoverable. Health diaries and conversation turns do not become personal facts.

First import validates source fingerprints. Changes to personal legacy values block import; independent journal changes do not break restart. Initialized canonical state is never reimported, including after clear. Before production data changes, verify backup, isolated restore, reconciliation counts, conflicts, duplicates and rollback. Any existing database state also requires its own approved private backup and restore check before modification.

Rollback disables new writes while retaining migrated-sender routing, encrypted state, schema, verified backup/plan and recovery key. Canonical reads remain available and deleted facts cannot reappear from JSON. Rolling back to an older binary without canonical routing requires explicit reverse reconciliation of new facts and deletions. Never restore stale JSON over current data.

## Flags and runtime status

All new rollout flags are off/unset. The audited Telegram workspace workflow was stopped with zero observed pollers and no local health response. Replit reports no published deployment; this alone does not establish whether another host is polling Telegram.

| Setting | Purpose / default |
| --- | --- |
| `ELI_UNIVERSAL_MEMORY_ENABLED` | Writes; false. |
| `ELI_UNIVERSAL_MEMORY_USERS` | Exact sender allowlist; empty, no wildcard or owner bypass. |
| `ELI_UNIVERSAL_MEMORY_MIGRATED_USERS` | Adopted senders; preserve for read routing during rollback. |
| `ELI_UNIVERSAL_MEMORY_BACKEND` | Supabase in production. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Private server REST credentials. |
| `ELI_UNIVERSAL_MEMORY_KEY` | Encryption and recovery secret. |
| `ELI_UNIVERSAL_MEMORY_LEGACY_DIRECTORY` | Actual legacy location, respecting storage overrides. |
| `ELI_UNIVERSAL_MEMORY_BACKUP` | Absolute verified encrypted archive location. |
| `ELI_UNIVERSAL_MEMORY_RECONCILIATION` | Absolute verified encrypted reconciliation plan location. |

Only after all gates pass: preserve the rollback release, reconcile onto the newest source, stop polling for cutover, enable exact canaries plus migrated-sender protection, start one poller and verify health and sanitized logs. Do not send test messages to real users without permission. Expansion requires actual persistent write/readback, update/delete and restart verification through the runtime.

## Validation

Unit/regression tests exercise arbitrary facts, operation routing, identity isolation, real filesystem writes, a fresh Node-process reload, corruption, failure/readback handling, consent, prompt injection, daily journals, byte-preserving backup, legacy reconciliation, actual `askEli` and actual show/forget/coaching/plan paths. Provider and REST doubles are used in unit tests; these do not prove production persistence.

GitHub Actions runs pinned runtime dependencies, an actual PostgreSQL 17 schema/RLS/grants/CAS check and two competing database sessions. At commit `2553728`, all three jobs passed: 108 memory tests plus 43 runtime tests, zero failures, two separate live integration tests skipped. Evidence: [workflow 38073657212](https://github.com/vv80715-beep/zdrave-na-avtopilot-bot/actions/runs/38073657212). Later source changes require a new CI result.

Live AI tests use the actual SDK/model with synthetic facts and an encrypted filesystem repository, checking readback and re-created service recall. Live database tests require actual Supabase REST credentials, refuse existing synthetic IDs, leave only empty encrypted synthetic state after cleanup, and never poll Telegram or send messages. Neither test is accepted as passed when skipped. The prior ad-hoc in-memory model runs exposed defects but do not substitute for the committed automated filesystem or real database tests.

Outstanding release gates: exact corrected-source real-model tests; integration with newer Replit code; compatible production reconciliation; independent recovery; runtime credentials; applied and verified memory schema; real Supabase REST persistence and restart; runtime routing checks; single-poller/health verification; controlled activation.

Stripe Checkout/webhooks, subscriptions, Community, Voice and Avatar implementations are outside this change.
