# Eli V2.2 universal personal memory — staged GitHub implementation

Status: code and synthetic regression tests are ready for review. This is **not an activated production deployment**. Real-model extraction, PostgREST access, current Replit reconciliation, production backup and Telegram rollout remain release gates.

## Reproduced cause and source boundary

The latest available V2.2 GitHub base is `cd1d96f31e2bfbb333e50307f9d8460b410c82ad` on `fix/eli-v22-owner-memory-github-20261008`. `main` is older. The previously inspected Replit HEAD, `c6793593dd7f837a9bd9de5b3b381560435d2fcd`, is not available in GitHub. This patch must be reconciled with that newer runtime code before deployment; it must never replace the Replit project with this GitHub snapshot.

`eliUniversalMemory.test.js` reproduces the favorite-color request against the unmodified legacy implementations:

| Stage | GitHub base behavior |
| --- | --- |
| `relationshipMemory.classifyMessage` | Fitness/health-oriented lexical rules return `ignore` for favorite color. |
| `brain/memoryCandidate.extractMemoryCandidate` | Selected profile paths and health-related patterns return `ignore`, with no persistence. |
| `brain/ownerGoalMemory` | Owner-only fitness-goal handler; arbitrary personal facts are outside its scope. |
| Existing durable repository | In-memory foundation, not a verified production Supabase writer. |
| JSON loaders | Separate sources; malformed JSON may be treated as empty by legacy loaders. |

The earlier read-only runtime audit also identified a restricted explicit-preference handler in the newer Replit code, but that handler is absent from this GitHub base. Consequently the automated reproduction proves the GitHub restriction; it does not substitute for a current runtime test of the unpublished handler. The owner durable-memory flags were off in that earlier audit. Their present runtime values were not rechecked after access to Replit was prohibited.

Read-only Supabase inspection on 2026-10-09 confirmed PostgreSQL 17.6, an existing server `service_role` with BYPASSRLS, no `public.eli_memory_state`, and no memory Edge Function. No table, function, payment record, user record or deployment was changed during that inspection. Database connectivity through the management connector does not prove connectivity from the bot runtime.

## Generic path and source of truth

For explicitly selected canary senders:

1. Trusted `ctx.from.id` determines the sender. Model output never determines an identity. Private memory cannot be displayed or mutated in groups.
2. Operation detection recognizes remember/update/delete/clear/recall commands without enumerating fact categories.
3. `gpt-4o-mini` extracts a strict structured result: arbitrary semantic topic, literal evidence, existing fact ID, and semantic relation. Safety classification separates ordinary facts, sensitive facts, daily reports, unsafe input and unclear input.
4. Validation rejects invented evidence, foreign fact IDs, secrets and instructions. Paraphrases can retain an existing fact; conflicting values require an explicit update.
5. One per-sender state holds stable UUIDs, timestamps, consent metadata and bounded idempotency receipts. No raw incoming message is stored as a receipt.
6. AES-256-GCM encrypts the state, bound to the sender and revision. PostgreSQL compare-and-swap prevents silent concurrent overwrites.
7. A fresh read must match the expected revision and entire state before success is confirmed. Database/model/refusal/integrity failures consume the command and return an honest failure, without writing elsewhere.
8. Future conversations select relevant IDs semantically from that sender's verified records. Facts are JSON data with explicit instructions against executing their contents.

Enabled canaries bypass legacy owner-goal, relationship-memory and personal-profile dumps, passive relationship capture and personal memory wizard. `/showmemory` reads the same canonical state. `/forget` directs the user to an explicit clear command; stale legacy buttons cannot erase health logs. Coaching and plan requests also use canonical personal context, retaining separate health measurements. The administrative inspection command cannot show stale legacy personal facts for migrated senders or expose their canonical private facts to another sender. Legacy JSON remains intact; health journals, check-ins, generated plans and administrative owner identity remain separate.

Normal canary chat uses the bounded RAM session, rather than persisting personal answers into the old unencrypted conversation file. Verified memory mutations clear that session. Limits are 200 personal facts per sender, 800 characters per fact, eight extracted facts per operation, eight context facts, and 50 idempotency receipts. Memory summaries respect Telegram text size and invite topic-specific recall when truncated. Writes beyond a limit fail visibly.

Sensitive facts require a fresh explicit consent reply owned by the same sender, tied to the unchanged revision, expiring after five minutes. Pending consent exists only in RAM. The encryption key is mandatory; missing configuration fails closed. Secrets, credentials and other people's private facts are rejected. Pattern guards, model instructions and structured validation are layered protections; the live adversarial tests must pass before release.

## Persistence and schema

`supabase/eli-universal-memory.sql` is a staged SQL specification, **not an applied or timestamped migration**. After backup and review, use `supabase migration new eli_universal_memory` and put the SQL in the CLI-created migration. Do not generate a guessed migration timestamp. The SQL creates only a new memory table and a server-only SECURITY INVOKER CAS function, enables RLS, revokes public/anon/authenticated access, and grants the minimal server permissions. Memory uses PostgREST directly from the server; existing Edge Functions are unaffected.

The filesystem repository is for isolated tests (`NODE_ENV=test`). Production requires the Supabase backend. There is no automatic filesystem fallback if Supabase is missing or unavailable. Encrypted row storage remains private server-side; no service key or encryption key is sent to Telegram or committed to GitHub.

## Backup and reconciliation before release

Keep private source data and all output artifacts outside the checkout. Configure `ELI_UNIVERSAL_MEMORY_KEY` in the host's secret manager: a canonical base64 encoding of 32 random bytes, with a separate protected recovery copy. Losing the key makes the encrypted state and backups unrecoverable. Never paste it in a PR or print it into captured logs.

The migration utility never writes to Supabase or legacy files. It backs up the exact available bytes of users, user memory, relationship memory, journals, check-ins, reminders and conversation state. Exclusive creation prevents overwriting a backup; decryption plus SHA-256 manifests verify completeness. Even malformed legacy bytes are preserved before the operation fails.

```sh
cd bot
node scripts/universalMemoryMigration.js backup /private/legacy /private/pre-rollout.memory-backup

# Only after authorizing upload of ordinary historical facts for reconciliation:
ELI_MEMORY_RECONCILIATION_AI_CONSENT=1 node scripts/universalMemoryMigration.js reconcile /private/legacy /private/pre-rollout.memory-backup /private/reconciled.memory-plan

node scripts/universalMemoryMigration.js verify /private/legacy /private/pre-rollout.memory-backup /private/reconciled.memory-plan
```

Reconciliation produces encrypted facts plus held records and aggregate counts. Exact/semantic duplicates can be consolidated; contradictions are held for private resolution. Historical sensitive/unsafe values are held without uploading them to the model. Unclear records are held. A sender with held records cannot be migrated until reviewed; nothing is silently discarded or overwritten. The complete original values remain in the verified backup. Health reports and conversation turns do not become personal facts. An already initialized canonical state is never reimported, including after clear. Changed legacy personal values block first import; changing journals independently does not break a restart.

Before any change to an existing memory schema or production records, also export that database state through an approved private backup workflow, verify it, and test restore in a disposable environment. That production database backup has not been performed in this GitHub-only task.

## Flags and controlled rollout

All new flags remain unset/off in this change. No actual host secrets or flags were modified.

| Setting | Purpose / default |
| --- | --- |
| `ELI_UNIVERSAL_MEMORY_ENABLED` | Write rollout; default false. |
| `ELI_UNIVERSAL_MEMORY_USERS` | Exact comma-separated sender allowlist; default empty. No wildcard or owner bypass. |
| `ELI_UNIVERSAL_MEMORY_MIGRATED_USERS` | Persist the adopted sender list before activation. Keeps canonical routing if writes are disabled for rollback. |
| `ELI_UNIVERSAL_MEMORY_BACKEND` | `supabase` in production; default supabase. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Server REST access; mandatory, never frontend/public. |
| `ELI_UNIVERSAL_MEMORY_KEY` | Mandatory encryption/recovery key. |
| `ELI_UNIVERSAL_MEMORY_LEGACY_DIRECTORY` | Actual legacy directory, including any env-configured storage files; default bot directory. |
| `ELI_UNIVERSAL_MEMORY_BACKUP` | Absolute verified encrypted backup path. |
| `ELI_UNIVERSAL_MEMORY_RECONCILIATION` | Absolute verified encrypted plan path. |

Use a staging project first. Run the real model/database tests below, resolve held records, prove restoration, then reconcile this commit with the newer runtime source. Stop polling before snapshot/cutover, preserve the previous release, set exact canaries and migrated-user protection, start exactly one polling process, check health and sanitized logs, and use only authorized test chats. Do not send test messages to real users without their permission. Expand only after actual read/write/readback, update/delete and restart checks pass through the Telegram runtime.

Rollback first disables writes with `ELI_UNIVERSAL_MEMORY_ENABLED=false` while retaining `ELI_UNIVERSAL_MEMORY_MIGRATED_USERS`, schema, encrypted records, backup paths and key. Migrated senders retain canonical read routing; old JSON facts cannot reappear. Do not roll back to a binary that lacks this routing protection after new writes/deletions. Returning to the legacy binary requires explicit reverse reconciliation of new facts and deletions, with verified backups. Never restore old JSON over the current data blindly.

## Validation and release blockers

```sh
node --test bot/test/eli*.test.js bot/test/relationshipMemory.test.js

# Deliberately configure real credentials privately; these are separate gates.
ELI_MEMORY_LIVE_AI_TESTS=1 node --test bot/test/eliUniversalMemoryLive.test.js
ELI_MEMORY_LIVE_DATABASE_TESTS=1 node --test bot/test/eliUniversalMemoryLive.test.js
```

The local suite includes actual filesystem persistence, an independent Node-process reload, corruption/integrity failures, atomic competing writes, migration backups, and execution of the actual `askEli` function with isolated dependencies. AI responses and REST transport are controlled in unit tests. Real OpenAI and Supabase integration tests are explicitly skipped unless enabled; skip is not production proof. Live database tests refuse to overwrite an existing synthetic ID and leave only an empty encrypted synthetic state after cleanup. They never poll Telegram or send a message.

GitHub Actions additionally runs the SQL on a fresh PostgreSQL 17 service, checks RLS/server grants and CAS, and races two independent database sessions. This is separate from the actual Supabase/PostgREST and runtime gates.

Local result at the implementation checkpoint: 99 passed, zero failures, two live tests skipped (101 total). An additional 20 daily-log/startup/command regressions passed. Syntax checks passed. The local owner-access regression could not start because the bot's `telegraf` dependency is not installed in this isolated checkout; the CI runtime job installs the pinned dependencies and runs it. GitHub CI results are recorded in the PR after the run.

Outstanding: newest runtime source reconciliation; actual legacy production backup/reconciliation; real-model extraction and adversarial checks; staged schema application and actual Supabase REST readback from the host; restore test; authorized Telegram runtime/restart checks; polling-process uniqueness; current runtime flags and health; controlled activation. No claim of production readiness or activation is made.

Stripe Checkout/webhooks, subscriptions, Community and Voice/Avatar implementations are outside this patch. Their files are preserved.
