# Eli Mini App: future read-only profile/progress GET

**Status: contract only. No route is implemented or mounted.** This proposal does
not read bot JSON files, query Supabase, or enable staging/production flags.
The current Mini App progress editor is browser-session-only and is not synced.

## Proposed request

`GET /api/mini-app/profile-progress?from=YYYY-MM-DD&to=YYYY-MM-DD`

- Reuse the existing owner Telegram `initData` exchange and its short-lived,
  `HttpOnly; Secure; SameSite=Strict` session cookie.
- Require the existing owner-session middleware; derive the Telegram subject
  from the verified session, never from query parameters or request JSON.
- Accept only a seven-day date window, with `to` no later than today.
- Return `Cache-Control: no-store`; reject cross-origin requests under the same
  origin policy as the existing owner-only staging router.
- Keep this route GET-only. There is no write/sync route in this contract.

## Response and privacy limits

The response shape is in `docs/schemas/eli-mini-app-profile-progress.schema.json`.
It contains only the seven-day window, an optional weekly movement-day goal,
aggregated active-day count/percentage/averages, and one energy value (or `null`)
per day. It must not include Telegram IDs, names, raw entries, chat text,
medical notes, addresses, photos, or storage paths. Null averages and missing
energy values remain `null`; they are not replaced with zero or interpolated.

`weeklyMovementGoalDays` is nullable. If no goal is available, the response must
not invent one. The UI may continue to show an explicit unsynced demo instead.

## Source and rollout constraints

- Do not serve this contract from the current demo API; no personal-data endpoint
  is authorized by this document.
- Before implementation, establish a verified HTTPS Telegram session flow and a
  shared server-side source for the bot's profile/progress. The bot's current
  JSON files are not a shared API store.
- A future implementation must use synthetic fixtures in tests first. It must
  not expose Supabase service-role credentials to the browser or read raw
  production JSON files.

## Mocked test coverage

The contract tests validate a synthetic aggregate response, reject extra
identity/raw-data fields and malformed or incomplete aggregates, and confirm the
current staging router still returns 404 for this unimplemented GET.
