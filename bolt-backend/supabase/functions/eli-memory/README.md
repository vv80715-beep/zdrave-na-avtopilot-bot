# Eli memory function — local deployment notes

**Prepared only.** This project has not applied the schema migration or deployed
this function. Do not run deployment or migration commands without separate
approval.

## Contract

- `GET /health`: authenticated schema/access probe. It selects zero rows and
  returns the contract version and approved project reference.
- `GET /?telegram_user_id=<Telegram ID>`: returns only active relationship
  memory facts for that exact ID. Health events, check-ins, profile rows, and
  short context are not returned by this endpoint.
- `POST /` with `operation: "save_fact"`: insert one active fact, then return
  the row only after validating the returned owner, category, value, and status.
- `POST /` with `operation: "update_fact"`: update an active fact constrained
  by both fact ID and Telegram ID; confirm the updated row.
- `POST /` with `operation: "delete_fact"`: soft-delete an active fact
  constrained by both fact ID and Telegram ID; confirm the deleted status.

All successful writes are read-after-write checked. Deletion is a soft delete
(`status = 'deleted'`), so it is omitted from future active-fact reads. The
function never reads or writes the daily health-event table.

## Required setup after approval

1. Confirm the approved project reference is `aoaylzncorwakxcactox`.
2. Apply the prepared foundation migration through the approved database
   workflow; this function's health probe must remain unready before the table
   exists.
3. Configure `ELI_MEMORY_INTERNAL_SECRET` in the Supabase function secrets and
   `ELI_MEMORY_BASE_URL` plus the same internal secret in the bot's Replit
   Secrets. Do not put secret values in source control, logs, or chat.
4. Deploy only this function using the approved project:

   ```sh
   supabase functions deploy eli-memory --project-ref aoaylzncorwakxcactox --no-verify-jwt
   ```

   JWT verification is disabled at the gateway because the bot uses the
   function's dedicated internal-secret header instead. The handler rejects
   requests without that header and pins its service-role URL to the approved
   project. Do not remove either check.
5. Verify `/health` using the bot client, then run synthetic per-user CRUD and
   cross-user isolation tests before considering any durable flag.

Do not enable `ELI_V2_2_DURABLE_MEMORY_ENABLED` or
`ELI_V2_2_DURABLE_READS_ENABLED` until backend access has been freshly verified.
Durable reads also require durable memory to be enabled for the owner canary.
