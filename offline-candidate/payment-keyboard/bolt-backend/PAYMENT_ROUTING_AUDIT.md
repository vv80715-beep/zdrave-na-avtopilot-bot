# Payment routing audit — 2026-09-17

> Historical initial-rollout snapshot, superseded for current backend status by
> `REVOLUT_ROUTING.md`. The later checkout-only update deployed api v14, added the
> server-only allowlist for the three newly supplied URLs and restricted TEST
> access. An authenticated read-only diagnostic confirmed the TEST runtime
> settings are absent, not merely unknown. The public Bolt frontend remains
> unchanged. The old source/build counts below describe the earlier snapshot.

## Outcome: partial rollout, NOT a completed live checkout

The existing Replit project was updated; no new project or payment link was
created. The canonical Supabase API and compatibility endpoint were updated.
The externally published Bolt frontend was **not** replaced.

| Audited surface | Literal Revolut payment URLs remaining |
| --- | ---: |
| Current Replit application source/configuration | 0 |
| Supplemental static frontend build | 0 |
| Deployed Supabase `api` (including shared module) | 0 |
| Deployed Supabase `revolut-test-checkout` | 0 |
| Public Bolt `confirmPlan-zi9BTtkL.js` | **3** |
| GitHub restoration repository `main`, API source | **1** |
| GitHub restoration repository `main`, old test router | **3** |
| Inspected GitHub `purchase.js` | 0 |
| Nineteen `public` database tables | 0 |
| `public` SQL functions, views and column defaults | 0 |
| Accessible nonsecret Replit environment values | 0 |

The old monthly ID remains in the GitHub API source, not in the deployed API.
Retired IDs in the new server validator are one-way rejection hashes, not URL
defaults. No retired ID is included in the frontend build.

The public asset audit fetched 21 pages/assets successfully. The public
confirm-plan bundle still selects three provider URLs in the browser, bypassing
the new backend flow. Therefore visitors are **not yet protected** by the new
failure handling on that entry point.

The connected GitHub repository is
`vv80715-beep/zdrave-na-avtopilot-v11-restoration`. Its current purchase source
already calls the API, unlike the published bundle, and its API source differs
from the deployed API outside payments too. No GitHub files were changed. Do not
overwrite the repository with the fetched deployed API or publish the older
local HTML snapshot over the live website. Establish the actual frontend release
source and apply narrow checkout-only changes there.

## Applied

- One canonical server flow for seven_day/monthly/yearly.
- One environment configuration value per mode/plan, with no URL defaults.
- Missing/invalid/unverified configuration returns a controlled 503 and no URL.
- Session token, expiry, stored plan, status, provider and reference are checked.
- Atomic session claims; no claim on configuration failure.
- TEST and production have separate providers/references and amount validation.
- The legacy test router and local Node route delegate to the canonical API.
- Local frontend redirects only from successful backend JSON and preserves the
  opaque session through internal plan/confirm links.
- A narrow database constraint extension permits a distinct production provider;
  no stored payment/session/entitlement rows were rewritten.
- Catalog prices remain EUR 15 / 50 / 360. No EUR 1 production price was set.

The deployed API was compared to the freshly retrieved baseline: bytes outside
the checkout function, its import and the checkout route call were unchanged.
Authentication settings were preserved. Auth, Community, Telegram/Eli
entitlements, Voice, Avatar, Stripe webhooks and TEST confirmation logic were
not modified.

## Verification and limits

- Application tests: **171 passed, 0 failed**.
- Frontend output guard: **1 passed**.
- Workspace TypeScript checks: passed.
- Edge Function TypeScript syntax checks: passed.
- Updated deployed API readiness: HTTP 200.
- Invalid-token requests: HTTP 400 from both checkout entry points, no redirect.
- Standard local Vite build: blocked because `bolt-backend` dependencies are not
  installed (`vite: not found`).
- Local React scaffold typecheck: eight missing React/types errors from that
  same pre-existing dependency gap. Unrelated scaffold code was not changed.
- Supplemental six-page static build: passed with the already-installed
  workspace Vite 7 and no PostCSS plugins. This confirms static asset bundling
  and the URL guard, **not** a passing normal Vite 5/Tailwind project build.
- The public screenshot checks the still-existing Bolt page, not the modified
  local frontend. No real payment or provider-page verification was performed.

Secret values were never read by the audit. Supabase secret inventory/values
were not inspected. No payment URL or mode environment value was set. Runtime
configuration rules are documented in `REVOLUT_ROUTING.md`.

## Required before calling this finished

1. Update and publish the actual Bolt frontend source so the three direct
   redirects disappear. Keep its current public content and unrelated features.
2. Remove the stale backend mappings from the authoritative repository before
   its next deployment; do not let it restore the retired URLs.
3. Provide and verify a new active reusable multi-payment TEST link with
   unlimited payments and no expiry, then configure its one server value.
4. Verify actual repeat payment behavior. Keep production disabled until its
   full-price link and production confirmation/access delivery are verified.