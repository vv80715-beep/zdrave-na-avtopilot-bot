# Build status — V11 Stripe + Telegram bridge

Дата: 19 август 2026 г.

## Завършено

### Web/backend

- Canonical планове и PostgreSQL purchase-session store.
- Stripe-hosted Checkout от server-side Price mapping.
- Price amount/currency/recurrence validation.
- Raw-body webhook signature verification.
- Idempotent `stripe_events`, `payments` и `entitlements`.
- One-time 7-day activation, subscription activation, renewal, failed-payment и cancellation handling.
- Public payment status без Telegram ID.
- Internal purchase-session и entitlement endpoints с `api_version: 1`.
- Production fail-closed конфигурация и database-aware readiness.

### EliZdraveBot bridge

- Internal API client с HTTPS/secret validation, timeout, bounded response и no redirect.
- Same-origin opaque purchase URL validation.
- Strict entitlement contract validation.
- Paid backend entitlement override над local Trial.
- Забрана на втори Trial след платен plan history.
- Fail-closed Voice/Avatar при неуспешна backend проверка.
- Bounded LRU cache и concurrent request de-duplication.
- Forced entitlement refresh след `/start payment_complete`.
- Plan keyboard и purchase callbacks за трите canonical плана.
- Telegraf integration hooks и mode guard преди платени API действия.
- Payment status page deep link към `EliZdraveBot?start=payment_complete`.
- Отделен `.env.bot.example` и подробен `BOT_INTEGRATION.md`.

## Offline verification

```text
61 tests
61 passed
0 failed
```

- Server tests: 31/31.
- Bot bridge tests: 30/30.
- Combined suite: 61/61.
- JavaScript syntax: passed.
- HTML duplicate IDs/local assets: passed.
- CSS brace balance: passed.
- Payment status Telegram deep link: passed.
- Static backend/env/DB file protection: passed.

## Не е изпълнено в тази среда

- hosted PostgreSQL connection + real migration run;
- Stripe Dashboard test Products/Prices;
- Stripe CLI/test webhook delivery;
- реално test-mode card payment;
- директно изменение на реалния EliZdraveBot source project;
- production deployment;
- Avatar usage/battery/add-on ledger.

## Причина за bot source ограничението

Налични са доказателства за работещите `/setplan`, `/mode`, Text/Voice/Avatar потоци, но не и самите source файлове на EliZdraveBot. V11 затова доставя готов, отделен bridge package, който трябва да се включи към съществуващите handlers при достъп до проекта.

## Следващ контролиран етап

1. Достъп до реалния bot source.
2. Hosted PostgreSQL test database.
3. Stripe test keys, Price IDs и webhook secret.
4. Включване на bridge hooks към текущите bot handlers.
5. Един €15 test payment и един monthly subscription test payment.
6. Проверка webhook → entitlement → Telegram deep link → `/mode`.
7. Проверка, че Voice/Avatar/HeyGen не стартират при липса на verified access.
