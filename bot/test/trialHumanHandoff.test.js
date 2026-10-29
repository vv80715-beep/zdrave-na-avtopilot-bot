const test = require('node:test');
const assert = require('node:assert/strict');

const originalOwnerId = process.env.OWNER_TELEGRAM_ID;
const originalOwnerUrl = process.env.OWNER_TELEGRAM_URL;

const {
  isExplicitHumanHandoffRequest,
  isProductSupportQuestion,
  getOwnerTelegramUrl,
  buildOwnerContactKeyboard,
  resolveTrialHandoff,
} = require('../trialHumanHandoff');

test('explicit human-contact intent is detected without matching ordinary health language', () => {
  assert.equal(isExplicitHumanHandoffRequest('Искам да говоря с човек за продукта.'), true);
  assert.equal(isExplicitHumanHandoffRequest('Свържи ме с Дани, моля.'), true);
  assert.equal(isExplicitHumanHandoffRequest('Can I speak with a human agent?'), true);
  assert.equal(isExplicitHumanHandoffRequest('Колко вода трябва да пие човек на ден?'), false);
});

test('product/support questions are detected, health coaching questions are not', () => {
  assert.equal(isProductSupportQuestion('Какво представлява продуктът?'), true);
  assert.equal(isProductSupportQuestion('Колко струва месечният план?'), true);
  assert.equal(isProductSupportQuestion('Как работи плащането?'), true);
  assert.equal(isProductSupportQuestion('Как да спя по-добре тази вечер?'), false);
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

test('trial handoff is active only while free chat is active', () => {
  delete process.env.OWNER_TELEGRAM_URL;
  process.env.OWNER_TELEGRAM_ID = '123456';

  const trial = { plan: 'free', canChat: true };
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

test('contact keyboard contains one direct Telegram button', () => {
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
