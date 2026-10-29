const test = require('node:test');
const assert = require('node:assert/strict');

const originalOwnerId = process.env.OWNER_TELEGRAM_ID;
const originalOwnerUrl = process.env.OWNER_TELEGRAM_URL;

const {
  OFFER_TTL_MS,
  isExplicitHumanHandoffRequest,
  isProductSupportQuestion,
  isProductConcern,
  isHandoffAcceptance,
  isHandoffDecline,
  getOwnerTelegramUrl,
  buildOwnerContactKeyboard,
  isPendingOfferActive,
  resolveTrialHandoff,
  resolveOwnerExplicitHandoff,
} = require('../trialHumanHandoff');

test('explicit human-contact intent is detected without matching ordinary health language', () => {
  assert.equal(isExplicitHumanHandoffRequest('Искам да говоря с човек за продукта.'), true);
  assert.equal(isExplicitHumanHandoffRequest('Свържи ме с Дани, моля.'), true);
  assert.equal(isExplicitHumanHandoffRequest('Can I speak with a human agent?'), true);
  assert.equal(isExplicitHumanHandoffRequest('Искам истински човек.'), true);
  assert.equal(isExplicitHumanHandoffRequest('Колко вода трябва да пие човек на ден?'), false);
});

test('product/support questions are detected, health coaching questions are not', () => {
  assert.equal(isProductSupportQuestion('Какво представлява продуктът?'), true);
  assert.equal(isProductSupportQuestion('Колко струва месечният план?'), true);
  assert.equal(isProductSupportQuestion('Как работи плащането?'), true);
  assert.equal(isProductSupportQuestion('Как да спя по-добре тази вечер?'), false);
  assert.equal(isProductSupportQuestion('Как да се възстановя след тренировка?'), false);
  assert.equal(isProductSupportQuestion('Колко време да държа планк?'), false);
  assert.equal(isProductSupportQuestion('Как работи абонаментът?'), true);
  assert.equal(isProductSupportQuestion('Колко струва услугата?'), true);
});

test('concern offer is limited to product/support context', () => {
  assert.equal(isProductConcern('Притеснявам се дали плащането е сигурно.'), true);
  assert.equal(isProductConcern('Не съм сигурен за месечния абонамент.'), true);
  assert.equal(isProductConcern('Страх ме е, защото ме боли гърдите.'), false);
  assert.equal(isProductConcern('Притеснявам се за съня си.'), false);
});

test('yes/no after a handoff offer are recognized narrowly', () => {
  assert.equal(isHandoffAcceptance('Да'), true);
  assert.equal(isHandoffAcceptance('Да, моля'), true);
  assert.equal(isHandoffAcceptance('Искам'), true);
  assert.equal(isHandoffDecline('Не, благодаря'), true);
  assert.equal(isHandoffAcceptance('Да пия ли повече вода?'), false);
});

test('owner Telegram contact uses configured public URL first, then owner id fallback', () => {
  process.env.OWNER_TELEGRAM_URL = 'https://t.me/dani_test';
  process.env.OWNER_TELEGRAM_ID = '123456';
  assert.equal(getOwnerTelegramUrl(), 'https://t.me/dani_test');

  delete process.env.OWNER_TELEGRAM_URL;
  assert.equal(getOwnerTelegramUrl(), 'tg://user?id=123456');

  delete process.env.OWNER_TELEGRAM_ID;
  assert.equal(getOwnerTelegramUrl(), null);
});

test('pending handoff offer expires after 15 minutes', () => {
  const now = 1_000_000;
  assert.equal(isPendingOfferActive(now - OFFER_TTL_MS + 1, now), true);
  assert.equal(isPendingOfferActive(now - OFFER_TTL_MS - 1, now), false);
  assert.equal(isPendingOfferActive(null, now), false);
});

test('trial handoff offers first for concern, then sends profile only after consent', () => {
  delete process.env.OWNER_TELEGRAM_URL;
  process.env.OWNER_TELEGRAM_ID = '123456';

  const trial = { plan: 'free', canChat: true };
  assert.equal(resolveTrialHandoff(trial, 'Притеснявам се дали плащането е сигурно.').kind, 'offer');
  assert.equal(resolveTrialHandoff(trial, 'Да', { pendingOffer: true }).kind, 'immediate');
  assert.equal(resolveTrialHandoff(trial, 'Не, благодаря', { pendingOffer: true }).kind, 'decline');
  assert.equal(resolveTrialHandoff(trial, 'Искам да говоря с човек.').kind, 'immediate');
  assert.equal(resolveTrialHandoff(trial, 'Какво представлява продуктът?').kind, 'append');

  assert.equal(
    resolveTrialHandoff({ plan: 'monthly', canChat: true }, 'Искам човек.'),
    null
  );
  assert.equal(
    resolveTrialHandoff({ plan: 'free', canChat: false }, 'Искам човек.'),
    null
  );
});

test('owner explicit handoff uses the shared Dani button without Free Trial consent flow', () => {
  process.env.OWNER_TELEGRAM_URL = 'https://t.me/Danail321';
  const result = resolveOwnerExplicitHandoff('Ели, искам да говоря с истински човек.');
  assert.equal(result.kind, 'immediate');
  assert.equal(result.keyboard.reply_markup.inline_keyboard[0][0].url, 'https://t.me/Danail321');
  assert.equal(resolveOwnerExplicitHandoff('Как си днес?'), null);
});

test('contact keyboard contains one direct Telegram profile button', () => {
  delete process.env.OWNER_TELEGRAM_URL;
  process.env.OWNER_TELEGRAM_ID = '123456';
  const keyboard = buildOwnerContactKeyboard();
  assert.equal(keyboard.reply_markup.inline_keyboard[0][0].text, '👤 Свържи се с Дани');
  assert.equal(keyboard.reply_markup.inline_keyboard[0][0].url, 'tg://user?id=123456');
});

test.after(() => {
  if (originalOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
  else process.env.OWNER_TELEGRAM_ID = originalOwnerId;

  if (originalOwnerUrl === undefined) delete process.env.OWNER_TELEGRAM_URL;
  else process.env.OWNER_TELEGRAM_URL = originalOwnerUrl;
});
