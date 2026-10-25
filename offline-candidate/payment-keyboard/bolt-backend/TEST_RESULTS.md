# V11 verification results

Дата: 19 август 2026 г.

## Combined automated suite

```text
61 tests
61 passed
0 failed
0 cancelled
```

## Web/backend — 31/31

Критични случаи:

- canonical plan → Stripe Checkout;
- Telegram ID не излиза в public purchase URL/status API;
- repeated click не създава двойна Checkout Session;
- raw-body webhook signature flow;
- duplicate Stripe event idempotency;
- tampered amount fail-closed;
- €15 entitlement за точно 7 дни;
- subscription activation, renewal, failed invoice и cancellation;
- PostgreSQL event claim/commit/rollback/duplicate paths;
- production startup guards и database-aware readiness.

## Telegram bridge — 30/30

Критични случаи:

- production изисква HTTPS и силен internal secret;
- purchase POST изпраща само Telegram ID + canonical plan;
- same-origin opaque purchase URL;
- API version mismatch и cross-origin URL fail closed;
- owner/modes/period/Avatar allowance validation;
- entitlement GET retry only for retryable failure;
- timeout и oversized response fail closed;
- paid backend entitlement override над Trial;
- expired paid plan blocks second Trial;
- local Trial остава Text-only;
- Voice/Avatar се блокират при verification outage;
- stale fallback може да е само Text;
- bounded cache и forced refresh after payment;
- plan buttons само за трите canonical плана;
- payment-complete съобщение само за backend-verified active entitlement;
- mode keyboard само от разрешените режими;
- Telegraf mode guard блокира paid handler преди `next()`;
- bot client работи срещу реалния internal HTTP handler contract.

## Static checks

- всички JavaScript файлове: syntax OK;
- HTML duplicate IDs: няма;
- local HTML/CSS/JS targets: налични;
- CSS brace balance: OK;
- payment-status deep link: `https://t.me/EliZdraveBot?start=payment_complete`;
- `.env`, server source и DB migrations не се сервират като static assets.

## Реални проверки, които остават

- PostgreSQL connection + migrations в hosted test среда;
- Stripe test key/Price/webhook verification;
- Stripe CLI или hosted webhook delivery;
- реално test-mode card payment;
- bridge wiring в реалния EliZdraveBot project;
- Telegram `/start payment_complete` → `/mode` end-to-end;
- Avatar usage/battery и add-on ledger.
