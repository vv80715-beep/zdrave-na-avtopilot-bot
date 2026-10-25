# Здраве на автопилот — V11 Stripe + EliZdraveBot bridge

Тази версия надгражда V10 Stripe/PostgreSQL слоя с отделен, тестван bridge за свързване на реалния Telegram бот с purchase-session и entitlement API-то на платформата.

## Какво е готово

### Сайт и плащане

- Начална страница и отделни plan detail страници за `seven_day`, `monthly` и `yearly`.
- Защитена еднократна purchase session, създавана само от EliZdraveBot/backend.
- Stripe-hosted Checkout от canonical server-side Price ID.
- Проверен raw-body webhook и idempotent обработка на Stripe събития.
- PostgreSQL таблици за purchase sessions, Stripe events, payments и entitlements.
- Public payment-status страница, която не дава Premium от browser query параметър.
- След потвърдено плащане страницата връща към:

```text
https://t.me/EliZdraveBot?start=payment_complete
```

Ботът прави нова server-side entitlement проверка преди да съобщи, че планът е активен.

### Telegram bridge

Папката `bot-integration/` съдържа независими CommonJS модули без нова runtime зависимост:

- `eliPlatformClient.js` — защитен internal API client;
- `entitlementResolver.js` — обединява платения backend entitlement с текущия local Trial;
- `paymentFlow.js` — планови бутони, purchase link и payment-complete отговор;
- `example-telegraf-hooks.js` — примерни Telegraf hooks и mode guard;
- `index.js` — единен export;
- `test/` — offline contract, security и fail-closed тестове.

Bridge-ът налага следните правила:

- backend entitlement винаги има приоритет над local Trial;
- изтекъл платен план не получава втори Trial;
- Voice и Avatar се блокират, ако backend проверката не е успешна;
- при кратък backend outage може да остане само ограничен Text достъп според текущата локална логика;
- Telegram user ID никога не се добавя към публичния purchase URL;
- browser return от Stripe не активира Premium;
- платените OpenAI/TTS/HeyGen действия трябва да стоят след mode guard-а.

Точните инструкции за включване в съществуващия бот са в [BOT_INTEGRATION.md](BOT_INTEGRATION.md).

## Canonical планове

| Plan ID | Цена | Billing | Режими |
|---|---:|---|---|
| `seven_day` | €15 | еднократно, 7 дни | Text, Voice, Community |
| `monthly` | €50 | месечен subscription | Text, Voice, Avatar, Community; до 30 Avatar мин./месец |
| `yearly` | €360 | годишен subscription | Text, Voice, Avatar, Community; 20 Avatar мин./месец |

Backend-ът е единственият източник на истина за цена, billing type, payment и entitlement.

## Основен клиентски поток

```text
TikTok → сайт → 5-дневен Text Trial в EliZdraveBot
→ потребителят избира план в бота
→ bot bridge създава server-side purchase session
→ confirm-plan.html?session=<opaque token>
→ Stripe Checkout
→ verified webhook
→ payment + entitlement в PostgreSQL
→ payment-status.html
→ Telegram deep link /start payment_complete
→ bot bridge прави forced entitlement refresh
→ /mode показва само разрешените режими
```

## Инсталиране на web backend

Изисква Node.js 20+ и PostgreSQL.

```bash
npm install
cp .env.example .env
npm run db:migrate
npm test
npm start
```

Не комитвай `.env`, Stripe secret key, webhook secret, database credentials или `BOT_PURCHASE_API_SECRET`.

## Environment за EliZdraveBot

Копирай `.env.bot.example` в средата на бота и постави същия `BOT_PURCHASE_API_SECRET`, който използва web backend-ът.

Основните стойности са:

```text
ELI_PLATFORM_BASE_URL=https://<твоя-домейн>
BOT_PURCHASE_API_SECRET=<един и същ силен internal secret>
```

В production `ELI_PLATFORM_BASE_URL` трябва да е HTTPS.

## API договор

### Bot → purchase session

```http
POST /api/internal/purchase-sessions
Authorization: Bearer <BOT_PURCHASE_API_SECRET>
Content-Type: application/json

{
  "telegram_user_id": "8934490753",
  "plan_id": "monthly"
}
```

### Bot → entitlement

```http
GET /api/internal/entitlements/:telegramUserId
Authorization: Bearer <BOT_PURCHASE_API_SECRET>
```

Internal отговорите използват `api_version: 1`. Bridge-ът отказва непозната версия, различен Telegram user, непознат режим, невалиден период или несъответстващ Avatar allowance.

### Browser → Checkout

```http
POST /api/purchase-sessions/:opaqueToken/checkout
```

Plan и цена не се приемат от request body.

### Stripe → webhook

```http
POST /api/stripe/webhook
Stripe-Signature: ...
```

Webhook-ът се обработва само след signature verification върху непромененото raw body.

## Production fail-closed правила

Web backend-ът отказва production startup без:

- `DATABASE_URL`;
- HTTPS `APP_BASE_URL`;
- минимум 32-символен `BOT_PURCHASE_API_SECRET`;
- пълна Stripe test/live конфигурация;
- приложени PostgreSQL migrations.

Bot bridge-ът отказва production startup без HTTPS platform URL и силен internal secret.

## Безопасен Supabase deployment

Billing Edge Function-ът се deploy-ва само през guard-натия script. Одобреният
project reference и function identity са commit-нати в
`supabase/deploy-config.json`; не ги заменяй с project от текущо свързания
Supabase account.

Първо изпълни read-only preflight:

```bash
npm run supabase:preflight -- --project-ref aighgpkrexvhyvfohuxp
```

Той отказва липсващ или различен project reference, отпечатва target project-а
и function identity (`api`, `supabase/functions/api/index.ts`), след което
изпълнява само `supabase functions list`. Няма upload.

Само след успешен preflight изпълни:

```bash
npm run supabase:deploy -- --project-ref aighgpkrexvhyvfohuxp
```

Deploy командата повтаря същия read-only preflight непосредствено преди upload
и подава explicit `--project-ref` на Supabase CLI. Не използвай директно
`supabase functions deploy`: така се заобикаля защитата.

## Проверки в V11

```text
61 tests
61 passed
0 failed
```

Покрити са server payment flow и Telegram bridge логиката, включително:

- opaque purchase link без Telegram ID leak;
- API version и same-origin проверка;
- timeout, oversized response и retry поведение;
- active/expired/no-entitlement resolution;
- забрана на втори Trial след платен план;
- fail-closed Voice/Avatar при backend проблем;
- forced refresh след плащане;
- Stripe Checkout, webhook, idempotency, payments и entitlements;
- €15 точно 7 дни, subscription activation и renewal;
- tampered amount fail-closed;
- PostgreSQL transaction и readiness проверки.

## Какво още не е изпълнено

- реална PostgreSQL връзка и migrations в hosted среда;
- истински Stripe test keys, Price IDs и webhook secret;
- Stripe CLI/test-mode webhook delivery;
- реално test-mode плащане;
- директно поставяне на bridge модулите в source проекта на EliZdraveBot, защото неговите файлове не са налични в тази работна среда;
- Avatar usage/battery ledger и add-on минути — това остава отделен следващ слой след стабилния payment/entitlement flow.

Следващият контролиран тест е: hosted PostgreSQL + Stripe test mode + реалният bot source → едно €15 test плащане и едно subscription test плащане → webhook → entitlement → `/start payment_complete` → `/mode`.
