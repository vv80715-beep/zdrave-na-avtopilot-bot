# Avatar add-on reservation rollout — prepared locally, not deployed

The additive migration `supabase/migrations/20261001120000_avatar_addon_reservations.sql`
requires the existing Avatar usage/add-on tables, `record_avatar_usage`, and the
20260928150000 reservation migration. It preserves records and existing Owner
RPCs; it does not change purchase fulfillment, payment tables or webhooks.

Customer holds remain exactly 30 seconds. Funding is included-first, then
purchased time; included holds are period-specific and add-on holds are global.
Settlement uses the existing `record_avatar_usage` ledger writer at actual
duration, with unused held funds released atomically. That same writer excludes
other active holds, including when invoked by the existing direct usage API.
It may use only **unheld** included funds before unheld add-on funds. Submitted
and uncertain holds never age out. Videos exceeding 30 seconds remain withheld
for explicit reconciliation. Owner work never charges customer balances.
The legacy usage snapshot API remains a settled-usage display, not a reservation
authorization; the transactional RPC is the authoritative spending check.

Before rollout, obtain explicit approval for the production SQL migration and
separately for activating/restarting the bot. Verify the target Supabase project,
review current function/table definitions and grants against this migration,
and back up definitions and records. During the approved maintenance window,
pause new Avatar/legacy usage-recording intake and drain in-flight database
calls so no old ledger-writer invocation straddles the function replacement;
do not release pending provider jobs. Apply the additive migration transaction
**before** activating the bot's new total-balance validation/copy. Existing
included-only bot code safely rejects balances over 1800 during a staged rollout.
Do not reapply old migrations, reset balances, release uncertain jobs, or run
paid provider/payment calls as a deployment smoke test. Confirm the new RPC
definitions/grants and preservation of existing records with read-only checks.
Avoid rolling SQL back to included-only functions after any add-on-funded hold
exists; use a reviewed forward fix, preserving all holds and usage history.

Local verification (no secrets or external calls):

```sh
bash bolt-backend/supabase/tests/run_avatar_metering_local.sh
node --test bot/test/avatarMetering.test.js bot/test/avatarMeteringEdge.test.js bot/test/avatarDiagnostics.test.js bot/test/avatarRouting.test.js
```

The SQL runner creates and destroys a private socket-only PostgreSQL instance.
It checks legacy safety behavior, add-on funding, direct-recorder interaction,
and real parallel reservation/settlement sessions. JavaScript tests mock
metering/providers and do not write customer configuration or balance JSON.

# EliZdraveBot integration guide

Този документ описва как V11 bridge-ът се включва към съществуващия EliZdraveBot, без да променя основната му памет, persona, Text/Voice/Avatar routing или HeyGen pipeline.

## 1. Копиране на модулите

Копирай цялата папка:

```text
bot-integration/
```

в проекта на EliZdraveBot. Тя използва вградения Node.js `fetch` и няма нужда от отделна HTTP библиотека.

## 2. Environment

Добави стойностите от `.env.bot.example` в Secrets/Environment на бота:

```text
ELI_PLATFORM_BASE_URL=https://<домейн-на-платформата>
BOT_PURCHASE_API_SECRET=<същият силен secret като в web backend-а>
```

Не поставяй Stripe keys или database credentials в бота. Ботът говори само с internal API-то на платформата.

## 3. Инициализация

### 3a. Bootstrap с един вызов (препоръчително)

Копирай `bot-integration/` в проекта на EliZdraveBot, добави зависимост към `telegraf`, и извикай `wirePurchaseFlow` веднъж след създаването на bot-а:

```js
const { Telegraf } = require('telegraf');
const {
  EliPlatformClient,
  createEntitlementResolverFromEnv,
  wirePurchaseFlow,
} = require('./bot-integration');

const bot = new Telegraf(process.env.BOT_TOKEN);

const platformClient = EliPlatformClient.fromEnv(process.env);
const entitlementResolver = createEntitlementResolverFromEnv(
  platformClient,
  process.env,
);

wirePurchaseFlow({
  bot,
  client: platformClient,
  resolver: entitlementResolver,
  getLocalAccess: async (ctx) => getCurrentLocalAccess(String(ctx.from.id)),
  existingStartHandler: existingStartHandler, // опционално: запазва текущия /start flow
  existingPlansHandler: null,                  // опционално: замества /plans handler
  logger: console,
});

// ... останалите bot.command / bot.on регистрирани тук ...

bot.launch();
```

`wirePurchaseFlow` регистрира:
- `bot.command('plans')` → `handlePlansCommand`
- `bot.start()` → `handleStartMessage` (с fall-through към `existingStartHandler`)
- `bot.action('show_plans')` → показва плановете
- `bot.action('buy:seven_day' | 'buy:monthly' | 'buy:yearly')` → `createPurchaseReply`

Функцията е идемпотентна — повторно извикване не дублира регистрации.

### 3b. Ръчна регистрация (алтернативно)

```js
const {
  EliPlatformClient,
  createEntitlementResolverFromEnv,
  registerPurchaseActions,
  handleStartMessage,
  createModeGuard,
  showModeMenu,
  buildPlanKeyboard,
} = require('./bot-integration');

const platformClient = EliPlatformClient.fromEnv(process.env);
const entitlementResolver = createEntitlementResolverFromEnv(
  platformClient,
  process.env,
);
```

## 4. Планови бутони и purchase link

Регистрирай canonical callback actions веднъж:

```js
registerPurchaseActions({
  bot,
  client: platformClient,
  logger: console,
});
```

Покажи трите планови бутона от съществуващия Trial/expired flow:

```js
await ctx.reply('Избери план:', {
  reply_markup: buildPlanKeyboard(),
});
```

При натискане ботът изпраща `telegram_user_id + canonical plan_id` към internal endpoint-а. Потребителят получава само opaque URL от типа:

```text
https://<домейн>/confirm-plan.html?session=<random-token>
```

Няма Telegram ID, цена или entitlement claim в URL-а.

## 5. `/start` deep links

В началото на текущия `/start` handler извикай bridge handler-а:

```js
bot.start(async (ctx) => {
  const result = await handleStartMessage({
    ctx,
    client: platformClient,
    resolver: entitlementResolver,
    getLocalAccess: async (ctx) => {
      // Адаптирай към текущия bot entitlement/trial store.
      return getCurrentLocalAccess(String(ctx.from.id));
    },
  });

  if (result.handled) return;

  // След това остава сегашният normal /start flow.
  return existingStartHandler(ctx);
});
```

Поддържаните payload-и са:

```text
/start buy_seven_day
/start buy_monthly
/start buy_yearly
/start payment_complete
```

`payment_complete` не вярва на browser-а. Той изчиства cache-а и прави нова entitlement проверка от backend-а.

## 6. Mode guard преди платен API разход

Guard-ът трябва да бъде преди OpenAI/TTS/HeyGen повикването.

### Voice

```js
const voiceGuard = createModeGuard({
  resolver: entitlementResolver,
  mode: 'voice',
  getLocalAccess: async (ctx) => getCurrentLocalAccess(String(ctx.from.id)),
});

bot.on('voice', voiceGuard, existingVoiceHandler);
```

### Avatar

```js
const avatarGuard = createModeGuard({
  resolver: entitlementResolver,
  mode: 'avatar',
  getLocalAccess: async (ctx) => getCurrentLocalAccess(String(ctx.from.id)),
});

bot.action('mode:avatar', avatarGuard, async (ctx) => {
  // След entitlement guard-а запази и сегашната server-side Avatar
  // credit/usage проверка, преди да стартираш HeyGen.
  return existingAvatarHandler(ctx);
});
```

### Text

Text може да използва текущия 5-дневен local Trial. След изтекъл платен план bridge-ът блокира втори Trial, ако backend-ът има paid history или local store-ът подаде `hadPaidPlan: true`.

## 7. `/mode`

```js
bot.command('mode', async (ctx) => {
  await showModeMenu({
    ctx,
    resolver: entitlementResolver,
    getLocalAccess: async (ctx) => getCurrentLocalAccess(String(ctx.from.id)),
    force: true,
  });
});
```

Менюто се изгражда само от ефективно разрешените `text | voice | avatar` режими.

## 8. Local access adapter

Bridge-ът очаква обект с тази форма:

```js
{
  active: true,
  planId: 'free',
  state: 'trial',
  modes: ['text'],
  expiresAt: '2026-08-24T12:00:00.000Z',
  hadPaidPlan: false,
}
```

Правила:

- local Trial може да даде само `text`;
- `hadPaidPlan: true` блокира втори Trial, дори ако в момента няма active entitlement;
- backend paid entitlement винаги има приоритет;
- Voice/Avatar никога не се разрешават само от local state.

## 9. Error handling

При backend проблем:

- purchase link не се създава от guessed/fallback URL;
- Voice/Avatar се блокират преди платеното API повикване;
- валиден local Trial може да продължи само с Text;
- кратък stale paid cache може да позволи само Text, никога Voice/Avatar;
- internal secret и response body не се логват.

## 10. Проверка преди deployment

1. `node --test bot-integration/test/*.test.js`;
2. platform `/api/ready` връща `ok: true` и `api_version: 1`;
3. bot създава purchase URL без Telegram ID;
4. test webhook активира entitlement;
5. `https://t.me/EliZdraveBot?start=payment_complete` води до forced refresh;
6. `/mode` показва правилните режими;
7. Voice/Avatar handler не се стартира при неуспешна backend проверка;
8. Avatar usage/credit проверката остава преди HeyGen.

## 11. Текущо ограничение

Тези модули са готови и тествани като integration package, но не са автоматично вмъкнати в реалния EliZdraveBot проект, защото неговите source файлове не са налични в тази среда. При предоставяне на проекта трябва да се адаптират само имената на текущите handlers и local entitlement store-а; server contract-ът не се променя.
