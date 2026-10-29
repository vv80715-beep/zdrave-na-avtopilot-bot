const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isPurchaseIntent,
  handleFreeTrialPurchaseIntent,
} = require('../freeTrialPurchaseIntent');

test('detects direct Bulgarian Free Trial purchase intent', () => {
  for (const text of [
    'Искам да си купя абонамент',
    'Искам месечния план',
    'Как мога да си купя план?',
    'Искам да се абонирам',
    'Покажи ми плановете',
    'Искам да видя абонаментите',
  ]) {
    assert.equal(isPurchaseIntent(text), true, text);
  }
});

test('does not mistake negative or ordinary product questions for purchase intent', () => {
  for (const text of [
    'Не искам да купя абонамент',
    'Какво включва месечният план?',
    'Колко струва абонаментът?',
    'Не ми трябва план',
    'Имам въпрос за плащането',
  ]) {
    assert.equal(isPurchaseIntent(text), false, text);
  }
});

test('active Free Trial gets plan selection without AI', async () => {
  const replies = [];
  const ctx = { reply: async (text, markup) => replies.push({ text, markup }) };
  const status = {
    state: 'trial',
    plan: 'free',
    canChat: true,
    trialExpiresAt: Date.now() + 60_000,
  };
  assert.equal(await handleFreeTrialPurchaseIntent(ctx, 'Искам да си купя абонамент', status), true);
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /Избери кой план/);
  assert.equal(replies[0].markup.reply_markup.inline_keyboard.length, 3);
});

test('paid/non-trial users do not enter Free Trial purchase shortcut', async () => {
  const ctx = { reply: async () => { throw new Error('must not reply'); } };
  assert.equal(await handleFreeTrialPurchaseIntent(ctx, 'Искам абонамент', {
    state: 'paid', plan: 'monthly', canChat: true,
  }), false);
});
