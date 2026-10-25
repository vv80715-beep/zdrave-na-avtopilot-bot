# Purchase, Stripe и Telegram entitlement flow — V11

## 1. Източник на истина

Backend + PostgreSQL са единственият източник на истина за:

- Telegram user → canonical plan;
- цена и billing type;
- purchase session;
- Stripe Checkout binding;
- verified payment;
- entitlement, renewal и expiry.

Frontend query параметри, success page, Telegram callback data и local bot state никога не могат сами да дадат Premium права.

## 2. Bot-created purchase session

EliZdraveBot използва V11 bridge-а и извиква:

```http
POST /api/internal/purchase-sessions
Authorization: Bearer <BOT_PURCHASE_API_SECRET>
Content-Type: application/json

{
  "telegram_user_id": "8934490753",
  "plan_id": "monthly"
}
```

Backend-ът:

1. валидира Telegram ID и `seven_day | monthly | yearly`;
2. генерира 32-byte cryptographically random token;
3. пази само SHA-256 hash;
4. връща opaque same-origin URL;
5. не поставя Telegram ID, цена или entitlement в browser URL-а.

Bridge-ът проверява `api_version: 1`, exact origin, exact path и token shape. Не използва guessed fallback URL.

## 3. Checkout creation

`POST /api/purchase-sessions/:token/checkout`:

1. валидира trusted purchase session;
2. блокира ново плащане при активен entitlement;
3. зарежда canonical plan и Stripe Price ID server-side;
4. проверява Price amount/currency/recurrence;
5. създава Stripe-hosted Checkout с idempotency key;
6. записва Checkout Session ID и expiry;
7. удължава purchase-session expiry до Checkout expiry.

Telegram ID не се записва в публична Stripe metadata.

## 4. Verified webhook

`POST /api/stripe/webhook` получава непроменено raw body. Събитието се приема само след успешно `Stripe-Signature` verification.

Всяко Stripe event ID се claim-ва idempotent в същата DB transaction като payment/entitlement промяната. Повторен processed event е no-op. Failed event може да бъде retry-нат.

Не се пазят raw webhook payload, card data или customer email.

## 5. Activation и renewal

### €15 / 7 дни

Verified paid Checkout активира `seven_day` от event timestamp до точно +7 дни.

### €50 / месец и €360 / година

Verified subscription Checkout активира entitlement-а за платения Stripe subscription period. `invoice.paid` подновява до новия paid period end.

`invoice.payment_failed` маркира billing problem, но не отнема вече платения период преди expiry. Subscription deletion прекратява достъпа server-side.

## 6. Payment status page

Stripe success URL води към:

```text
/payment-status.html?checkout_session_id={CHECKOUT_SESSION_ID}
```

Страницата polling-ва безопасния public status endpoint. Тя не активира достъп.

След `paid + active` се показва:

```text
https://t.me/EliZdraveBot?start=payment_complete
```

## 7. Telegram forced refresh

При `/start payment_complete` bridge-ът:

1. изчиства entitlement cache-а за този Telegram user;
2. извиква internal entitlement endpoint-а;
3. проверява API version, owner, plan, modes, allowance и period;
4. съобщава „планът е активен“ само при `active + paid + backendVerified`;
5. показва mode keyboard само с разрешените режими.

Връщането от Stripe или натискането на Telegram deep link без backend entitlement не отключва Premium.

## 8. Paid request guards

Преди Voice/Avatar/OpenAI/TTS/HeyGen:

```text
Telegram request
→ EntitlementResolver.checkMode()
→ active backend entitlement?
→ mode in plan?
→ backendVerified?
→ existing Avatar usage/credit guard
→ paid API call
```

При backend outage Voice/Avatar fail closed. Валиден local Trial може да продължи само с Text. Ограничен stale paid fallback също може да бъде само Text.

## 9. Trial и expiry

- нов потребител: текущият 5-дневен Text-only Trial остава валиден;
- активен paid entitlement: backend-ът override-ва Trial;
- expired paid entitlement: няма втори Trial;
- profile/history/progress остават в bot/app storage;
- ново verified payment активира entitlement автоматично.

## 10. Оставащ end-to-end етап

1. hosted PostgreSQL;
2. Stripe test Products/Prices;
3. webhook secret и test delivery;
4. реалният EliZdraveBot source + bridge hooks;
5. test €15 payment;
6. test monthly subscription payment;
7. проверка payment page → Telegram deep link → forced refresh → `/mode`;
8. едва след това production/live keys.
