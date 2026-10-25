'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  wirePurchaseFlow,
  isFeatureRegistered,
  resolveClient,
  verifyBackendConfig,
  PURCHASE_FEATURE,
} = require('../botBootstrap.cjs');
const { EliPlatformClient } = require('../eliPlatformClient.cjs');

function makeFakeBot() {
  const commands = new Map();
  const actions = new Map();
  const starts = [];
  return {
    command: (name, handler) => { commands.set(name, handler); },
    action: (name, handler) => { actions.set(name, handler); },
    start: (handler) => { starts.push(handler); },
    _commands: commands,
    _actions: actions,
    _starts: starts,
  };
}

function makeClient() {
  return new EliPlatformClient({
    baseUrl: 'https://eli.example',
    internalSecret: 'a'.repeat(40),
    production: false,
  });
}

test('wirePurchaseFlow registers /plans, /start, show_plans, and all buy callbacks', () => {
  const bot = makeFakeBot();
  const client = makeClient();
  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  const result = wirePurchaseFlow({ bot, client, logger });

  assert.equal(result.alreadyRegistered, false);
  assert.equal(result.configOk, true);
  assert.ok(bot._commands.has('plans'));
  assert.equal(bot._starts.length, 1);
  assert.ok(bot._actions.has('show_plans'));
  assert.ok(bot._actions.has('buy:seven_day'));
  assert.ok(bot._actions.has('buy:monthly'));
  assert.ok(bot._actions.has('buy:yearly'));
});

test('wirePurchaseFlow prevents duplicate registration', () => {
  const bot = makeFakeBot();
  const client = makeClient();
  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  wirePurchaseFlow({ bot, client, logger });
  const result2 = wirePurchaseFlow({ bot, client, logger });

  assert.equal(result2.alreadyRegistered, true);
  assert.equal(bot._starts.length, 1);
  assert.equal(bot._commands.size, 1);
  assert.equal(bot._actions.size, 4);
});

test('isFeatureRegistered returns true after wiring', () => {
  const bot = makeFakeBot();
  const client = makeClient();
  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  assert.equal(isFeatureRegistered(bot, PURCHASE_FEATURE), false);
  wirePurchaseFlow({ bot, client, logger });
  assert.equal(isFeatureRegistered(bot, PURCHASE_FEATURE), true);
});

test('wirePurchaseFlow accepts env object and creates EliPlatformClient', () => {
  const bot = makeFakeBot();
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  const env = {
    ELI_PLATFORM_BASE_URL: 'https://eli.example',
    BOT_PURCHASE_API_SECRET: 'b'.repeat(40),
    NODE_ENV: 'development',
  };

  const result = wirePurchaseFlow({ bot, env, logger });
  assert.equal(result.alreadyRegistered, false);
  assert.ok(result.client instanceof EliPlatformClient);
  assert.equal(result.client.baseUrl, 'https://eli.example');
});

test('wirePurchaseFlow rejects when no client or env provided', () => {
  const bot = makeFakeBot();
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  assert.throws(
    () => wirePurchaseFlow({ bot, env: {}, logger }),
    /requires either an EliPlatformClient instance or an env object/,
  );
});

test('wirePurchaseFlow rejects when bot is not Telegraf-compatible', () => {
  assert.throws(
    () => wirePurchaseFlow({ bot: {}, client: makeClient() }),
    /requires a Telegraf-compatible bot instance/,
  );
});

test('verifyBackendConfig warns when secret is too short', () => {
  const client = new EliPlatformClient({
    baseUrl: 'https://eli.example',
    internalSecret: 'short',
    production: false,
  });
  const warnings = [];
  const logger = { warn: (msg) => { warnings.push(msg); } };
  const ok = verifyBackendConfig(client, logger);
  assert.equal(ok, false);
  assert.ok(warnings.length > 0);
});

test('verifyBackendConfig passes with valid config', () => {
  const client = makeClient();
  const logger = { warn: () => {} };
  assert.equal(verifyBackendConfig(client, logger), true);
});

test('/plans command handler shows all 3 plans', async () => {
  const bot = makeFakeBot();
  const client = makeClient();
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  wirePurchaseFlow({ bot, client, logger });

  const replies = [];
  const ctx = {
    from: { id: 8934490753 },
    reply: async (text, extra) => { replies.push({ text, extra }); },
  };
  await bot._commands.get('plans')(ctx);
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /7 дни — €15/);
  assert.match(replies[0].text, /1 месец — €50/);
  assert.match(replies[0].text, /1 година — €360/);
  const buttons = replies[0].extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, ['buy:seven_day', 'buy:monthly', 'buy:yearly']);
});

test('/start normal start shows plans discovery button', async () => {
  const bot = makeFakeBot();
  const client = makeClient();
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  wirePurchaseFlow({ bot, client, logger });

  const replies = [];
  const ctx = {
    from: { id: 8934490753 },
    message: { text: '/start' },
    reply: async (text, extra) => { replies.push({ text, extra }); },
  };
  await bot._starts[0](ctx);
  assert.equal(replies.length, 1);
  const buttons = replies[0].extra.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === 'show_plans'));
  assert.ok(buttons.some((b) => b.text.includes('Планове и абонамент')));
});

test('/start buy_seven_day deep link creates purchase session', async () => {
  const bot = makeFakeBot();
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  const client = {
    createPurchaseSession: async ({ telegramUserId, planId }) => ({
      purchaseUrl: `https://eli.example/confirm-plan.html?session=${'A'.repeat(43)}`,
      expiresAt: new Date('2026-08-19T10:15:00.000Z'),
      plan: { id: planId, name: '7 дни с Ели' },
    }),
  };
  wirePurchaseFlow({ bot, client, logger });

  const replies = [];
  const ctx = {
    from: { id: 8934490753 },
    message: { text: '/start buy_seven_day' },
    reply: async (text, extra) => { replies.push({ text, extra }); },
  };
  await bot._starts[0](ctx);
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /7-дневния план/);
  assert.match(replies[0].extra.reply_markup.inline_keyboard[0][0].url, /confirm-plan\.html\?session=/);
});

test('/start with unknown payload falls through to existing handler', async () => {
  const bot = makeFakeBot();
  const client = makeClient();
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  let existingCalled = false;
  const existingStartHandler = async (ctx) => {
    existingCalled = true;
    await ctx.reply('Existing start flow.');
  };
  wirePurchaseFlow({ bot, client, logger, existingStartHandler });

  const replies = [];
  const ctx = {
    from: { id: 8934490753 },
    message: { text: '/start some_unknown_payload' },
    reply: async (text, extra) => { replies.push({ text, extra }); },
  };
  await bot._starts[0](ctx);
  assert.equal(existingCalled, true);
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /Existing start flow/);
});

test('show_plans callback handler shows all 3 plans', async () => {
  const bot = makeFakeBot();
  const client = makeClient();
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  wirePurchaseFlow({ bot, client, logger });

  const replies = [];
  const ctx = {
    from: { id: 8934490753 },
    answerCbQuery: async () => {},
    reply: async (text, extra) => { replies.push({ text, extra }); },
  };
  await bot._actions.get('show_plans')(ctx);
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /7 дни — €15/);
  assert.match(replies[0].text, /1 месец — €50/);
  assert.match(replies[0].text, /1 година — €360/);
});

test('buy:monthly callback creates purchase session with Telegram ID from context', async () => {
  const bot = makeFakeBot();
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  let capturedUserId = null;
  let capturedPlanId = null;
  const client = {
    createPurchaseSession: async ({ telegramUserId, planId }) => {
      capturedUserId = telegramUserId;
      capturedPlanId = planId;
      return {
        purchaseUrl: `https://eli.example/confirm-plan.html?session=${'B'.repeat(43)}`,
        expiresAt: new Date('2026-08-19T10:15:00.000Z'),
        plan: { id: planId, name: '1 месец с Ели' },
      };
    },
  };
  wirePurchaseFlow({ bot, client, logger });

  const replies = [];
  const ctx = {
    from: { id: 8934490753 },
    answerCbQuery: async () => {},
    reply: async (text, extra) => { replies.push({ text, extra }); },
  };
  await bot._actions.get('buy:monthly')(ctx);
  assert.equal(capturedUserId, '8934490753');
  assert.equal(capturedPlanId, 'monthly');
  assert.match(replies[0].text, /месечния план/);
});

test('resolveClient returns passed client as-is', () => {
  const client = makeClient();
  assert.equal(resolveClient(client), client);
});

test('resolveClient creates client from env', () => {
  const env = {
    ELI_PLATFORM_BASE_URL: 'https://eli.example',
    BOT_PURCHASE_API_SECRET: 'c'.repeat(40),
    NODE_ENV: 'development',
  };
  const client = resolveClient(env);
  assert.ok(client instanceof EliPlatformClient);
  assert.equal(client.baseUrl, 'https://eli.example');
});
