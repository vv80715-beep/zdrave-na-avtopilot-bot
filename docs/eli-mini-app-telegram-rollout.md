# Eli Mini App → Telegram rollout preparation

This document describes the isolated demo preparation only. The Mini App still
has no account session, live chat API, entitlement API, or payment integration.
Do not connect it to customer data or paid providers until the prerequisites
below have been approved and tested in a separate staging environment.

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
- The API artifact currently has only `/api/healthz`; the Mini App is local
  demo content. No user identity or client-supplied plan is trusted here.
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

The normal welcome may include an inline Web App button only when both
conditions are explicitly true:

```text
ELI_MINI_APP_START_BUTTON_ENABLED=true
ELI_MINI_APP_STAGE=staging
ELI_MINI_APP_URL=https://<public-host>/<app-path>
```

All three settings are required; the default is off, and `NODE_ENV=production`
also disables the button. The URL must parse as HTTPS and use a non-local,
non-reserved hostname. This is a format guard, not proof that DNS, TLS, or
public reachability work. No environment value was set as part of this change.
Existing `/start buy_*` and `/start payment_complete` paths are unchanged.
`/start` only displays a button; the user must tap it to open the Mini App.

After an HTTPS deployment and explicit approval, configure the global menu in
BotFather with `/setmenubutton` or use Bot API `setChatMenuButton`. Configure
the bot's Main Mini App separately before sharing a direct link such as
`https://t.me/<bot_username>?startapp`. Do not distribute a guessed or
unconfigured link.

## Server authentication foundation

The API artifact can serve production traffic and currently has no isolated
staging deployment or Mini App auth route. To avoid adding a live-looking route
to that service, this change adds only a pure validator and offline tests; it is
not imported by the API router and is not reachable over HTTP.

Before exposing an endpoint:

1. Deploy a separate HTTPS staging API and separate test bot; never use the
   production polling token in a second process.
2. Validate the **raw** `Telegram.WebApp.initData` HMAC server-side using the
   server-only bot token, reject stale/future `auth_date`, and use the verified
   Telegram user ID only. Never accept a client-provided ID or plan as proof.
3. Exchange valid initData for a short-lived, protected server session; do not
   put the bot token or internal Bolt purchase secret in frontend code.
4. Add explicit owner allowlisting on the server. Do not use current production
   owner exceptions as staging isolation.
5. Keep AI, Voice, HeyGen, metering, memory, and payment routes disabled until
   their shared existing gates and transport contracts have an isolated test.

The offline validator tests use only a fabricated token and signed test payloads.
They cover valid data, modified/forged data, expired timestamps, and future
timestamps. They make no Telegram, database, payment, or AI calls.

## Digital purchase boundary

The current plans use the existing Stripe/Bolt flow. Do not expose that checkout
inside the Telegram Mini App without a Telegram Stars policy review. If digital
access is sold inside Telegram, implement Telegram Stars invoice, confirmation,
refund/support, and idempotent entitlement fulfillment as a separately
approved project. Keep the existing Stripe and entitlement code unchanged in
this rollout preparation.
