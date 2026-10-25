# Eli V2.2 Universal Memory backend (prepared, not deployed)

This Edge Function is deliberately owner-scoped. It stores only AES-GCM
ciphertext in `eli_universal_memory_facts`; the Telegram bot must never receive
the Supabase service-role key or the encryption key.

## Backend runtime settings

Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to its Edge
Function runtime. Configure these additional values in the **Supabase Edge
Function secret store**, not in Replit:

- `ELI_OWNER_TELEGRAM_ID` — the one Telegram ID allowed to read or mutate facts.
- `ELI_MEMORY_INTERNAL_SECRET` — must match the Replit bot secret.
- `ELI_UNIVERSAL_MEMORY_KEY` — canonical base64 encoding of 32 random bytes;
  this value must be generated and managed by the project owner.

The bot separately needs `OWNER_TELEGRAM_ID`, the pinned
`ELI_MEMORY_BASE_URL`, and the matching `ELI_MEMORY_INTERNAL_SECRET` in Replit
Secrets. Do not put `SUPABASE_SERVICE_ROLE_KEY` in the bot workspace.

## Safe validation sequence

1. Use a disposable Supabase project for the approved project reference and
   apply `supabase/migrations/20261011000000_eli_universal_memory.sql` there
   only after explicit approval.
2. Deploy this function only to that disposable project. Configure the three
   function secrets above, with a synthetic test owner ID.
3. Confirm `/health` returns the approved project reference and contract
   version; then test save, read, update, forget, isolation, and restart/readback
   using only synthetic facts. Verify deleted facts no longer appear.
4. Do not put a real owner's ID or production credentials in the disposable
   project. Production schema changes, function deployment, rollout flags, and
   bot restart each require separate explicit approval.

No migration or function deployment is performed by this repository change.
