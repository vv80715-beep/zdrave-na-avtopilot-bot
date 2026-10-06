# Revolut checkout routing

## Authority and deployment boundary

The existing billing authority is the Supabase `api` function in project
`aoaylzncorwakxcactox`. The canonical route is
`POST /functions/v1/api/purchase-sessions/:token/checkout`.

The frontend verifies the opaque purchase session first, then POSTs its token.
The API revalidates the session and chooses **only its stored plan**. A browser
plan, provider, mode, success URL or checkout URL cannot select the payment.
The legacy `revolut-test-checkout` route and local Node checkout route forward to
this API; neither owns a provider map.

The API source was refreshed from the deployed version before modifying the
checkout code. Other deployed routes must remain byte-for-byte unchanged.
The checkout-only internal diagnostic route is described below.
Do not replace the live website with this older local website snapshot: Bolt
publishing is separate and its current source must receive the same routing
change without replacing unrelated public content, auth or Community.

## One server configuration value per mode/plan

Configuration is read **only by the canonical API**, from its Supabase function
environment. Replit frontend `VITE_*` settings do not configure payments.

`REVOLUT_CHECKOUT_MODE` must explicitly equal `test` or `production`. An unset,
invalid or disabled value fails closed. There is no automatic mode or URL.

| Plan | TEST setting | Production setting | Production EUR cents |
| --- | --- | --- | --- |
| seven_day | REVOLUT_TEST_SEVEN_DAY | REVOLUT_PRODUCTION_SEVEN_DAY | 1500 |
| monthly | REVOLUT_TEST_MONTHLY | REVOLUT_PRODUCTION_MONTHLY | 5000 |
| yearly | REVOLUT_TEST_YEARLY | REVOLUT_PRODUCTION_YEARLY | 36000 |

Each setting is **one JSON value** holding the URL and its verification record.
The three operator-supplied TEST destinations are defined only in the server-only
`supabase/functions/_shared/revolut-test-links.mjs` allowlist. This allowlist does
not activate them: each runtime JSON setting must still pass verification.
An inactive template:

```json
{
  "mode": "test",
  "plan_id": "monthly",
  "url": "",
  "currency": "EUR",
  "amount_cents": 100,
  "accept_multiple_payments": false,
  "payment_limit": null,
  "status": "unverified",
  "expires_at": null,
  "verified": false,
  "verified_url_sha256": ""
}
```

Before setting a real value, the operator must verify the actual provider link:

- Accept multiple payments = ON.
- Payment limit = No limit / unlimited.
- Status = Active.
- No expiry date.
- Amount and currency match the selected mode/plan.
- Repeated payments remain possible; a successful page load alone is not proof.

Then store `accept_multiple_payments: true`, `payment_limit: "unlimited"`,
`status: "active"`, `expires_at: null`, `verified: true`, and the SHA-256 of the
**exact verified URL** as `verified_url_sha256`, together in that single value.
These flags are an operator attestation, not a live Revolut availability check.
For production, replacing a link replaces just that one setting, including its
new verification record; production behavior is unchanged.
For this controlled TEST rollout, each plan must additionally match its supplied
destination in the server-only allowlist. The allowlist is not a URL fallback.
Changing a future TEST destination requires an explicit allowlist update and
regeneration of its runtime setting. A valid hash alone cannot authorize a
different plan's EUR 1 link.

The resolver rejects malformed URLs, non-HTTPS, credentials, query/hash,
noncanonical paths, all seven retired link IDs (stored only as one-way hashes),
an attestation for a different URL, and a link reused across plans or modes.
In TEST, every destination except the exact three supplied plan-specific URLs
is rejected, including older links not in the seven-ID retired list.

TEST requires exactly EUR 100 cents, never a catalog price change. Production
requires 1500/5000/36000 cents. A TEST setting cannot fill a production gap.

## Restricted TEST access and configuration preparation

`REVOLUT_TEST_ALLOWED_TELEGRAM_IDS` must be a comma-separated list of permitted
Telegram IDs. For owner-only testing, set only the owner's ID. The API checks
the stored session identity, never a request-body or query identity. Missing,
malformed or nonmatching permission returns 403 `test_checkout_forbidden`,
without a URL or session claim. The permission check also runs on repeat
requests, so removing a tester immediately stops further URL disclosure.
Production does not use this allowlist.

To print candidate settings without writing any environment or changing any
production values, run from `bolt-backend`:

```sh
node scripts/print-revolut-test-settings.mjs --testers=<comma-separated-test-IDs>
```

The output contains only mode, allowed testers, and the three TEST JSON strings.
By default they are **unverified and inactive**, despite containing the exact
supplied URLs and calculated hashes. After independently verifying all provider
properties listed above, the operator can explicitly append `--provider-verified`.
This flag records an operator attestation; the command does not inspect Revolut.
Do not claim successful payment/reusability based on the local tests.

Apply the three TEST settings and the tester list in the **Supabase project
aoaylzncorwakxcactox**, then explicitly set `REVOLUT_CHECKOUT_MODE=test`.
Do not put them in frontend VITE variables or assume Replit env changes apply to
Supabase. Never touch `REVOLUT_PRODUCTION_*` during this operation.

## Read-only runtime verification

`GET /functions/v1/api/internal/checkout-config-status` uses the existing internal
bot bearer authentication. It returns only a normalized mode and booleans for
configuration presence, matching approved URLs/hashes, tester-list validity and
per-plan readiness. It never returns URLs, hashes, customer IDs or raw settings.
It performs no database write, checkout/session creation or provider request.

```sh
node scripts/check-revolut-runtime.mjs
```

This uses the existing bot credential without displaying it. Exit 0 means all
three TEST configurations are ready; exit 2 means configuration is incomplete;
exit 1 means the diagnostic request failed. Readiness is not proof of a payment
or provider-side availability.

The rollout's authenticated runtime check returned `mode: unconfigured`,
`tester_allowlist_configured: false`, and `configured: false` for all three plans.
The API was updated to v14, but Supabase environment values were **not** changed:
the available connector provides Edge Function deployment, not environment writes.
The public Bolt bundle still contains three old direct URLs and was not published.

## Failure, persistence and payment confirmation

Missing/invalid/unverified configuration returns HTTP 503,
`error: "checkout_not_configured"` and
`message: "Checkout временно не е конфигуриран."`, with **no checkout URL**.
The browser shows the message and does not redirect. The purchase session is not
claimed or changed on this failure.

A configured checkout atomically claims an unexpired pending session and
preserves `checkout_provider`, `checkout_reference`, `checkout_created_at`,
`updated_at` and status `checkout_created`. Repeated requests are checked against
current configuration and the stored provider/reference, not a cached URL.
Paid/cancelled/expired/Stripe-owned or differently-mode-bound sessions are not
reused. Historical sessions/payments/references are not deleted or rewritten.

TEST references remain compatible with the existing manual confirmation RPC:
`<plan>_eur_1_reusable_v1`, provider `revolut_pro_test`. Production uses its
distinct provider `revolut_pro` and actual-price reference. The small schema
migration only permits that new provider value; it changes no payment status.

This routing change does not implement new entitlement or payment-confirmation
logic. Existing TEST manual confirmation and Stripe webhooks stay unchanged.
Do not enable production until its full-price link **and production payment
confirmation/access delivery** are verified. A redirect is not proof of payment.

## Checks

- `npm test`: existing tests plus checkout configuration/flow and frontend tests.
- `npm run typecheck`: local TypeScript application check.
- `npm run build`: regular Vite frontend build (requires local dependencies).
- `npm run test:frontend:build-guard`: mandatory scan of built HTML/JS/CSS.

The build guard must fail when `dist` is absent; it must not silently skip.
No test performs a real provider payment or uses a fabricated Revolut URL.