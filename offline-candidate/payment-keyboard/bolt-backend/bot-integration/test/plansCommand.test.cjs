'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPlanKeyboard,
  buildPlansOverviewText,
  buildStartReply,
  parsePlanCallbackData,
  createPurchaseReply,
} = require('../paymentFlow.cjs');
const {
  handlePlansCommand,
  handleShowPlansCallback,
  handleStartMessage,
  registerPurchaseActions,
  telegramUserIdFromContext,
} = require('../example-telegraf-hooks.cjs');
const { PLANS } = require('../../server/plans');
const {
  PurchaseSessionService,
  MemoryPurchaseSessionStore,
  generateToken,
  hashToken,
} = require('../../server/purchaseSessionService');

const TELEGRAM_USER_ID = '8934490753';

function makeCtx({ fromId = TELEGRAM_USER_ID, text = '' } = {}) {
  const replies = [];
  return {
    from: { id: fromId },
    message: { text },
    answerCbQuery: async () => {},
    reply: async (replyText, extra) => { replies.push({ text: replyText, extra }); },
    _replies: replies,
  };
}

function makeClient({ baseUrl = 'https://eli.example' } = {}) {
  return {
    createPurchaseSession: async ({ telegramUserId, planId }) => ({
      purchaseUrl: `${baseUrl}/confirm-plan.html?session=${planId}${'A'.repeat(40)}`,
      expiresAt: new Date('2026-08-19T10:15:00.000Z'),
      plan: { id: planId, name: PLANS[planId]?.name || planId },
    }),
  };
}

test('/plans command returns all 3 canonical plans', async () => {
  const ctx = makeCtx();
  const result = await handlePlansCommand({ ctx, logger: { error: () => {} } });
  assert.equal(result.handled, true);
  assert.equal(ctx._replies.length, 1);
  const reply = ctx._replies[0];
  assert.match(reply.text, /7 дни — €15/);
  assert.match(reply.text, /1 месец — €50/);
  assert.match(reply.text, /1 година — €360/);
  const buttons = reply.extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, ['buy:seven_day', 'buy:monthly', 'buy:yearly']);
});

test('show_plans callback returns the same 3 plan buttons', async () => {
  const ctx = makeCtx();
  const result = await handleShowPlansCallback({ ctx, logger: { error: () => {} } });
  assert.equal(result.handled, true);
  const buttons = ctx._replies[0].extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, ['buy:seven_day', 'buy:monthly', 'buy:yearly']);
});

test('/start normal start includes a Планове и абонамент button', async () => {
  const ctx = makeCtx({ text: '/start' });
  const result = await handleStartMessage({
    ctx,
    client: makeClient(),
    resolver: {},
  });
  assert.equal(result.handled, true);
  assert.equal(result.type, 'normal_start');
  const buttons = ctx._replies[0].extra.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === 'show_plans'));
  assert.ok(buttons.some((b) => b.text && b.text.includes('Планове и абонамент')));
});

test('Telegram ID comes from bot context, not user input', () => {
  const ctx = makeCtx({ fromId: TELEGRAM_USER_ID });
  assert.equal(telegramUserIdFromContext(ctx), TELEGRAM_USER_ID);
  assert.equal(telegramUserIdFromContext({ from: { id: null } }), '');
  assert.equal(telegramUserIdFromContext({}), '');
});

test('valid 7-day selection creates secure session with correct plan', async () => {
  let capturedUserId = null;
  let capturedPlanId = null;
  const reply = await createPurchaseReply({
    client: {
      createPurchaseSession: async ({ telegramUserId, planId }) => {
        capturedUserId = telegramUserId;
        capturedPlanId = planId;
        return {
          purchaseUrl: `https://eli.example/confirm-plan.html?session=${'A'.repeat(43)}`,
          expiresAt: new Date('2026-08-19T10:15:00.000Z'),
          plan: { id: 'seven_day', name: '7 дни с Ели' },
        };
      },
    },
    telegramUserId: TELEGRAM_USER_ID,
    planId: 'seven_day',
  });
  assert.equal(capturedUserId, TELEGRAM_USER_ID);
  assert.equal(capturedPlanId, 'seven_day');
  assert.equal(reply.plan.id, 'seven_day');
  assert.match(reply.text, /7-дневния план/);
});

test('valid monthly selection creates secure session with correct plan', async () => {
  const reply = await createPurchaseReply({
    client: makeClient(),
    telegramUserId: TELEGRAM_USER_ID,
    planId: 'monthly',
  });
  assert.equal(reply.plan.id, 'monthly');
  assert.match(reply.text, /месечния план/);
  assert.match(reply.replyMarkup.inline_keyboard[0][0].url, /confirm-plan\.html\?session=/);
});

test('valid yearly selection creates secure session with correct plan', async () => {
  const reply = await createPurchaseReply({
    client: makeClient(),
    telegramUserId: TELEGRAM_USER_ID,
    planId: 'yearly',
  });
  assert.equal(reply.plan.id, 'yearly');
  assert.match(reply.text, /годишния план/);
  assert.match(reply.replyMarkup.inline_keyboard[0][0].url, /confirm-plan\.html\?session=/);
});

test('invalid plan rejected by createPurchaseReply', async () => {
  await assert.rejects(
    () => createPurchaseReply({
      client: makeClient(),
      telegramUserId: TELEGRAM_USER_ID,
      planId: 'vip',
    }),
    /Invalid Telegram user or plan/,
  );
});

test('invalid plan rejected by parsePlanCallbackData', () => {
  assert.equal(parsePlanCallbackData('buy:vip'), null);
  assert.equal(parsePlanCallbackData('buy:free'), null);
  assert.equal(parsePlanCallbackData(''), null);
});

test('registered buy action uses Telegram ID from context, not from message text', async () => {
  const handlers = new Map();
  const bot = { action: (name, handler) => handlers.set(name, handler) };
  let capturedUserId = null;
  registerPurchaseActions({
    bot,
    client: {
      createPurchaseSession: async ({ telegramUserId, planId }) => {
        capturedUserId = telegramUserId;
        return {
          purchaseUrl: `https://eli.example/confirm-plan.html?session=${'A'.repeat(43)}`,
          expiresAt: new Date('2026-08-19T10:15:00.000Z'),
          plan: { id: planId },
        };
      },
    },
    logger: { error: () => {} },
  });

  const ctx = makeCtx({ fromId: TELEGRAM_USER_ID });
  await handlers.get('buy:seven_day')(ctx);
  assert.equal(capturedUserId, TELEGRAM_USER_ID);
  assert.ok(ctx._replies[0].text.includes('7-дневния план'));
});

test('registered show_plans action returns plan keyboard', async () => {
  const handlers = new Map();
  const bot = { action: (name, handler) => handlers.set(name, handler) };
  registerPurchaseActions({
    bot,
    client: makeClient(),
    logger: { error: () => {} },
  });

  assert.ok(handlers.has('show_plans'));
  const ctx = makeCtx();
  await handlers.get('show_plans')(ctx);
  const buttons = ctx._replies[0].extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, ['buy:seven_day', 'buy:monthly', 'buy:yearly']);
});

test('purchase session linked to correct Telegram user via server-side service', async () => {
  const now = () => new Date('2026-08-19T10:00:00.000Z');
  const store = new MemoryPurchaseSessionStore({ now });
  const service = new PurchaseSessionService({
    store,
    now,
    ttlMinutes: 15,
    appBaseUrl: 'https://zdrave.example',
  });

  const result = await service.createSession({
    telegramUserId: TELEGRAM_USER_ID,
    planId: 'monthly',
  });
  assert.equal(result.ok, true);
  assert.equal(result.body.plan.id, 'monthly');

  const session = await store.findByTokenHash(hashToken(result.token));
  assert.equal(session.telegram_user_id, TELEGRAM_USER_ID);
  assert.equal(session.plan_id, 'monthly');
});

test('valid token makes confirm-plan READY (verified state)', async () => {
  const now = () => new Date('2026-08-19T10:00:00.000Z');
  const service = new PurchaseSessionService({
    store: new MemoryPurchaseSessionStore({ now }),
    now,
    ttlMinutes: 15,
  });

  const created = await service.createSession({
    telegramUserId: TELEGRAM_USER_ID,
    planId: 'monthly',
  });
  const verified = await service.verifySession(created.token);
  assert.equal(verified.ok, true);
  assert.equal(verified.body.status, 'pending');
  assert.equal(verified.body.plan_id, 'monthly');
});

test('invalid token remains blocked (not found)', async () => {
  const now = () => new Date('2026-08-19T10:00:00.000Z');
  const service = new PurchaseSessionService({
    store: new MemoryPurchaseSessionStore({ now }),
    now,
    ttlMinutes: 15,
  });

  const result = await service.verifySession(generateToken());
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test('malformed token is rejected', async () => {
  const now = () => new Date('2026-08-19T10:00:00.000Z');
  const service = new PurchaseSessionService({
    store: new MemoryPurchaseSessionStore({ now }),
    now,
    ttlMinutes: 15,
  });

  const result = await service.verifySession('not-a-valid-token!!!');
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test('expired token remains blocked (410)', async () => {
  let clock = new Date('2026-08-19T10:00:00.000Z');
  const now = () => clock;
  const store = new MemoryPurchaseSessionStore({ now });
  const service = new PurchaseSessionService({
    store,
    now,
    ttlMinutes: 15,
  });

  const created = await service.createSession({
    telegramUserId: TELEGRAM_USER_ID,
    planId: 'seven_day',
  });

  clock = new Date('2026-08-19T11:00:00.000Z');

  const result = await service.verifySession(created.token);
  assert.equal(result.ok, false);
  assert.equal(result.status, 410);
});

test('no entitlement before Stripe webhook — session does not grant access', async () => {
  const now = () => new Date('2026-08-19T10:00:00.000Z');
  const store = new MemoryPurchaseSessionStore({ now });
  const service = new PurchaseSessionService({
    store,
    now,
    ttlMinutes: 15,
  });

  const created = await service.createSession({
    telegramUserId: TELEGRAM_USER_ID,
    planId: 'monthly',
  });
  const verified = await service.verifySession(created.token);
  assert.equal(verified.ok, true);
  const session = await store.findByTokenHash(hashToken(created.token));
  assert.equal(session.status, 'pending');
  assert.equal(session.stripe_checkout_session_id, null);
});

test('duplicate purchase-session creation does not produce duplicate paid entitlement', async () => {
  const now = () => new Date('2026-08-19T10:00:00.000Z');
  const store = new MemoryPurchaseSessionStore({ now });
  const service = new PurchaseSessionService({
    store,
    now,
    ttlMinutes: 15,
  });

  const a = await service.createSession({ telegramUserId: TELEGRAM_USER_ID, planId: 'monthly' });
  const b = await service.createSession({ telegramUserId: TELEGRAM_USER_ID, planId: 'monthly' });
  assert.notEqual(a.token, b.token);

  const sessionA = await store.findByTokenHash(hashToken(a.token));
  const sessionB = await store.findByTokenHash(hashToken(b.token));
  assert.equal(sessionA.status, 'pending');
  assert.equal(sessionB.status, 'pending');
  assert.equal(sessionA.stripe_checkout_session_id, null);
  assert.equal(sessionB.stripe_checkout_session_id, null);

  await store.updateStatus(hashToken(a.token), 'paid', {
    consumed_at: now,
    stripe_checkout_session_id: 'cs_test_123',
  });
  const sessionAReloaded = await store.findByTokenHash(hashToken(a.token));
  assert.equal(sessionAReloaded.status, 'paid');

  const reverify = await service.verifySession(a.token);
  assert.equal(reverify.ok, false);
  assert.equal(reverify.status, 410);
});

test('purchase URL contains only the session token, no Telegram ID or plan ID', async () => {
  const now = () => new Date('2026-08-19T10:00:00.000Z');
  const service = new PurchaseSessionService({
    store: new MemoryPurchaseSessionStore({ now }),
    now,
    ttlMinutes: 15,
    appBaseUrl: 'https://zdrave-na-avtopilot-dkr6.bolt.host',
  });

  const result = await service.createSession({
    telegramUserId: TELEGRAM_USER_ID,
    planId: 'seven_day',
  });
  const url = new URL(result.body.purchase_url);
  assert.equal(url.pathname, '/confirm-plan.html');
  assert.deepEqual([...url.searchParams.keys()], ['session']);
  assert.equal(url.searchParams.get('telegram_user_id'), null);
  assert.equal(url.searchParams.get('plan'), null);
  assert.equal(url.searchParams.get('plan_id'), null);
  assert.ok(!url.search.includes(TELEGRAM_USER_ID));
});

test('buildPlanKeyboard exposes exactly three canonical plan buttons', () => {
  const keyboard = buildPlanKeyboard();
  const buttons = keyboard.inline_keyboard.flat();
  assert.equal(buttons.length, 3);
  assert.deepEqual(
    buttons.map((b) => b.callback_data),
    ['buy:seven_day', 'buy:monthly', 'buy:yearly'],
  );
});

test('buildPlansOverviewText includes all plan names and prices', () => {
  const text = buildPlansOverviewText();
  assert.match(text, /7 дни — €15/);
  assert.match(text, /1 месец — €50/);
  assert.match(text, /1 година — €360/);
  assert.match(text, /не активира Premium/);
});

test('buildStartReply includes plans discovery button', () => {
  const reply = buildStartReply();
  const buttons = reply.replyMarkup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === 'show_plans'));
  assert.ok(buttons.some((b) => b.text.includes('Планове и абонамент')));
});

test('plan prices match the server-side canonical catalog', () => {
  const overview = buildPlansOverviewText();
  assert.match(overview, new RegExp(`€${PLANS.seven_day.price.amount}`));
  assert.match(overview, new RegExp(`€${PLANS.monthly.price.amount}`));
  assert.match(overview, new RegExp(`€${PLANS.yearly.price.amount}`));
});
