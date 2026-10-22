# Eli Mini App → Telegram rollout preparation

This document describes the isolated demo and owner-only staging foundation.
The Mini App has no live customer session, live AI chat, entitlement API, or
payment integration. The staging routes are not mounted unless every explicit
development-only guard is configured.

## Confirmed access rules in the existing bot

- The original free trial starts on first user creation and lasts five days.
  `/start` does not renew it. It allows text chat; after expiry the bot returns
  a static message without an AI completion.
- Trial entitlement exposes only the `text` reply mode. The existing bot also
  has a separate incoming-voice transcription path guarded by general chat
  access, so an active trial can send a voice note for transcription even though
  it cannot receive paid Voice-mode output. Keep the Mini App's requested
  trial experience text-only until that distinction is explicitly approved.
- `seven_day` is a seven-day paid plan with Text + Voice and no Avatar.
- `monthly` is 30 days with Text + Voice + Avatar and 30 included Avatar
  minutes per period.
- `yearly` is 365 days with Text + Voice + Avatar and 20 included Avatar
  minutes per period.
- Paid access is verified by the existing Bolt entitlement resolver. Voice and
  Avatar provider calls must retain their server-side gates. Avatar also uses
  the existing durable allowance/reservation and actual-duration metering,
  including purchased add-on time. It reserves 30 seconds before generation
  and does not send a generated video longer than 20 seconds.
- The API has `/api/healthz` plus disabled-by-default owner-only staging routes
  described below. No customer identity or client-supplied plan is trusted.
- The production bot's owner role bypasses normal customer chat gates. Avatar
  generation has an owner authorization exception but can still reach real
  metering and HeyGen; it is not a staging shortcut.

## Demo behavior

- “Пиши на Ели / Write to Eli” opens the existing local demo chat.
- Voice and Video show a localized notice: an eligible plan is required and
  the feature is not connected in this demo. No network request is made.
- Telegram WebApp SDK support is optional. In Telegram, the app requests
  `ready()` and `expand()`, observes viewport/safe-area/theme changes, and
  keeps the black-green brand. A regular browser remains the default demo.
- `initDataUnsafe` is not used as authentication. No initData is sent anywhere
  by the demo frontend.

## `/start` inline button guard

Only the configured owner in a private chat can receive the inline Web App
button. It remains disabled unless all conditions below are explicitly true:

```text
ELI_MINI_APP_START_BUTTON_ENABLED=true
ELI_MINI_APP_STAGE=staging
ELI_MINI_APP_URL=https://<public-host>/<app-path>
```

All three settings are required; the default is off, and `NODE_ENV=production`
also disables the button. Existing `/start buy_*` and `/start payment_complete`
paths do not receive the Mini App button. The URL must parse as HTTPS and use a non-local,
non-reserved hostname. This is a format guard, not proof that DNS, TLS, or
public reachability work. No environment value was set as part of this change.
`/start` only displays a button; the user must tap it to open the Mini App.

After an HTTPS deployment and explicit approval, configure the global menu in
BotFather with `/setmenubutton` or use Bot API `setChatMenuButton`. Configure
the bot's Main Mini App separately before sharing a direct link such as
`https://t.me/<bot_username>?startapp`. Do not distribute a guessed or
unconfigured link.

## Owner-only staging API foundation

The API mounts `/api/mini-app/session` and `/api/mini-app/demo-chat` only when
all of these hold: `NODE_ENV=development`, `ELI_MINI_APP_STAGE=staging`,
`ELI_MINI_APP_SESSION_ENABLED=true`, a valid exact HTTPS
`ELI_MINI_APP_ORIGIN`, a valid `OWNER_TELEGRAM_ID`, `TELEGRAM_BOT_TOKEN`, and a
32+ character `SESSION_SECRET`. Missing configuration fails closed. No such
staging flags/origin are currently configured, so these routes are not mounted.
Production `NODE_ENV` cannot mount them.

`POST /api/mini-app/session` accepts only raw Telegram `initData`, verifies the
HMAC and five-minute `auth_date` freshness on the server, and compares the
verified ID to the configured owner ID. It rejects replayed initData and issues
a ten-minute `HttpOnly; Secure; SameSite=Strict` cookie. The server token and
owner ID never enter frontend code or responses.

`POST /api/mini-app/demo-chat` requires that session and exact Origin, then
returns fixed BG/EN text. It does not call an AI/provider, database, memory,
health, billing, TTS, or video service and does not store or return the input.
The dedicated router enforces exact-origin CORS and CSRF checks before the
existing general CORS middleware, leaving existing route behavior unchanged.

Tests use a fabricated bot token and signed payloads. They cover valid, forged,
expired and replayed initData; non-owner IDs; absent flags/secrets; session
expiry; missing sessions; exact-origin CORS/CSRF; and the static response.
They make no Telegram, database, payment, or AI calls.

For a Telegram owner test, the remaining prerequisites are an HTTPS origin
reachable from Telegram, explicit development/staging flags, verification that
the existing bot's server-side owner config matches the intended account, and
an owner-only launch action. Do not start a second polling process or configure
BotFather until separately approved. This foundation is not a live integration.

## Digital purchase boundary

The current plans use the existing Stripe/Bolt flow. Do not expose that checkout
inside the Telegram Mini App without a Telegram Stars policy review. If digital
access is sold inside Telegram, implement Telegram Stars invoice, confirmation,
refund/support, and idempotent entitlement fulfillment as a separately
approved project. Keep the existing Stripe and entitlement code unchanged in
this rollout preparation.
