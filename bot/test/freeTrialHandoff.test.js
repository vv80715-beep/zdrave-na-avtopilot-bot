const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createFreeTrialHandoffHandler,
  isActiveFreeTrial,
  isExplicitHumanRequest,
  isProductConcern,
  ownerProfileUrl,
} = require('../freeTrialHandoff');

const NOW = 1_800_000_000_000;
const OWNER_ID = '123456789';
const trial = {
  plan: 'free',
  state: 'trial',
  canChat: true,
  trialExpiresAt: NOW + 60_000,
};

function ctx(id = '987654321') {
  return {
    from: { id },
    replies: [],
    async reply(text, extra) {
      this.replies.push({ text, extra });
      return this.replies.at(-1);
    },
  };
}

function handler() {
  return createFreeTrialHandoffHandler({
    ownerTelegramId: OWNER_ID,
    now: () => NOW,
  });
}

test('active free trial explicit request immediately gets Dani profile button', async () => {
  const handle = handler();
  const message = ctx();

  assert.equal(isActiveFreeTrial(trial, NOW), true);
  assert.equal(isExplicitHumanRequest('Искам да говоря с Дани'), true);
  assert.equal(await handle(message, 'Искам да говоря с Дани', trial), true);
  assert.equal(message.replies.length, 1);
  assert.deepEqual(message.replies[0].extra.reply_markup.inline_keyboard[0][0], {
    text: 'Отвори профила на Дани',
    url: `tg://user?id=${OWNER_ID}`,
  });
});

test('product concern asks consent first and only an affirmative reply shows the link', async () => {
  const handle = handler();
  const message = ctx();

  assert.equal(isProductConcern('Притеснявам се дали плащането е безопасно'), true);
  assert.equal(await handle(message, 'Притеснявам се дали плащането е безопасно', trial), true);
  assert.equal(message.replies[0].text, 'Ако искаш, можем да те свържем с реален човек. Искаш ли?');
  assert.equal(message.replies[0].extra, undefined);

  assert.equal(await handle(message, 'Да, моля', trial), true);
  assert.equal(message.replies.length, 2);
  assert.equal(
    message.replies[1].extra.reply_markup.inline_keyboard[0][0].url,
    `tg://user?id=${OWNER_ID}`
  );
});

test('declining consent clears the pending handoff and continues normal handling', async () => {
  const handle = handler();
  const message = ctx();

  await handle(message, 'Не съм сигурна за абонамента', trial);
  assert.equal(await handle(message, 'Не благодаря', trial), false);
  assert.equal(message.replies.length, 1);
});

test('ordinary health and symptom concerns are not product-support handoffs', async () => {
  const handle = handler();
  const message = ctx();
  const question = 'Притеснявам се за болката в коляното';

  assert.equal(isProductConcern(question), false);
  assert.equal(isExplicitHumanRequest(question), false);
  assert.equal(await handle(message, question, trial), false);
  assert.equal(message.replies.length, 0);
});

test('paid plans and expired trial never receive the free-trial handoff', async () => {
  const handle = handler();
  const message = ctx();
  const paidStatuses = ['seven_day', 'monthly', 'yearly'].map((plan) => ({
    plan,
    state: 'paid',
    canChat: true,
    allowedModes: ['text', 'voice'],
    trialExpiresAt: NOW + 60_000,
  }));

  for (const status of paidStatuses) {
    assert.equal(await handle(message, 'Свържи ме с Дани', status), false);
  }
  const expired = { ...trial, state: 'trial_expired', canChat: false, trialExpiresAt: NOW - 1 };
  assert.equal(isActiveFreeTrial(expired, NOW), false);
  assert.equal(await handle(message, 'Свържи ме с Дани', expired), false);
  assert.equal(message.replies.length, 0);
});

test('owner link uses configured numeric Telegram identity; invalid values fail closed', () => {
  assert.equal(ownerProfileUrl(OWNER_ID), `tg://user?id=${OWNER_ID}`);
  assert.equal(ownerProfileUrl('https://t.me/not-the-owner'), null);
});

test('text handler offers trial handoff before the unavailable-AI fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const start = source.indexOf("bot.on('text', async (ctx) => {");
  const end = source.indexOf("\nbot.catch(", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const textHandler = source.slice(start, end);
  const providerCheck = textHandler.indexOf('if (!hasTextAIProvider');
  const statusRead = textHandler.indexOf('resolveAccessStatus(ctx)', providerCheck);
  const handoff = textHandler.indexOf('handleFreeTrialHandoff(ctx, ctx.message.text, status)', statusRead);
  const unavailableReply = textHandler.indexOf('В момента не мога да ползвам AI мозъка си', handoff);

  assert.ok(providerCheck >= 0);
  assert.ok(statusRead > providerCheck);
  assert.ok(handoff > statusRead);
  assert.ok(unavailableReply > handoff);
});

test('paid-enabled user-facing routes check handoff after normal entitlement gate', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const askStart = source.indexOf("bot.command('ask', async (ctx) => {");
  const textStart = source.indexOf("bot.on('text', async (ctx) => {");
  const textEnd = source.indexOf('\nbot.catch(', textStart);
  const askRoute = source.slice(askStart, source.indexOf('\n});', askStart) + 4);
  const textRoute = source.slice(textStart, textEnd);

  assert.ok(askRoute.indexOf('await gateChat(ctx)') >= 0);
  assert.ok(askRoute.indexOf('handleFreeTrialHandoff(ctx, question, status)') > askRoute.indexOf('await gateChat(ctx)'));
  const gate = textRoute.indexOf('await gateChat(ctx)');
  const gatedHandoff = textRoute.indexOf('handleFreeTrialHandoff(ctx, ctx.message.text, status)', gate);
  assert.ok(gate >= 0);
  assert.ok(gatedHandoff > gate);
});
