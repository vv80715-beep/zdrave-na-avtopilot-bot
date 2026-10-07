# Eli V2.2 — Step 6 Final Non-Production Review

Step 6 validates the migration foundation using fixtures only.

It verifies:
- SHA-256 manifest consistency;
- dry-run validation with zero external writes;
- per-Telegram-user reconciliation;
- user-data isolation;
- bounded short context;
- detection of missing short-context expiry;
- blocking on invalid data, conflicts, checksum changes, or mismatches.

A successful result is `non_production_foundation_complete`.

This does not authorize production activation.

Still forbidden without separate approval:
- applying the Supabase migration;
- deploying the eli-memory Edge Function;
- importing real user JSON;
- enabling durable reads or dual-write;
- restarting production;
- merging into main;
- touching Stripe, payment webhooks, entitlements, plans, Community, or HeyGen;
- changing the model from gpt-4o-mini.
