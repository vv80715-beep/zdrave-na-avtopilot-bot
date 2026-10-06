const test = require('node:test');
const assert = require('node:assert/strict');
const { Telegraf, Telegram, Scenes, session } = require('telegraf');
const startCommands = require('../commands/start');
const plans = require('../commands/plans');

function harness({ failPurchase = false } = {}) {
  const bot = new Telegraf('123:offline');
  bot.botInfo = { id: 999, is_bot: true, first_name: 'Eli', username: 'EliTestBot' };
  const sent = [];
  const purchases = [];
  const users = [];
  const refreshes = [];
  const client = {
    async createPurchaseSession(id, planId) {
      purchases.push({ id, planId });
      if (failPurchase) throw new Error('sensitive');
      return {
        plan: { id: planId, name: planId },
        purchase_url: `https://checkout.example/confirm-plan.html?session=${'A'.repeat(43)}`,
      };
    },
  };
  Telegram.prototype.callApi = async (method, data) => {
    sent.push({ method, data });
    return { message_id: sent.length };
  };
  bot.use(session());
  bot.use((ctx, next) => {
    ctx.session ??= {};
    ctx.session.memory ??= 'kept';
    return next();
  });
  startCommands.register(bot, {
    ensureUser: (id) => users.push(id),
    isOwner: (ctx) => ctx.from.id === 12345,
    ownerName: 'Собственик',
    purchasePlan: (ctx, planId) => plans.sendPurchaseLink(ctx, planId, client),
    refreshPaymentComplete: async (ctx) => {
      refreshes.push(ctx.from.id);
      return ctx.reply('Плащането е проверено.');
    },
  });
  plans.register(bot, { client });
  bot.command('inspect', (ctx) => ctx.reply(ctx.session.memory || 'erased'));
  const wizard = new Scenes.WizardScene('wizard', (ctx) => ctx.reply('Scene intercepted'));
  bot.use(new Scenes.Stage([wizard]).middleware());
  bot.command('wizard', (ctx) => ctx.scene.enter('wizard'));
  let updateId = 0;
  async function send(text, { from = 23456, chat = from, type = 'private' } = {}) {
    const before = sent.length;
    const command = text.match(/^\/([a-z]+)/i)?.[0];
    const message = {
      message_id: ++updateId,
      date: 1,
      text,
      entities: command ? [{ type: 'bot_command', offset: 0, length: command.length }] : [],
      from: { id: from, is_bot: false, first_name: 'Тест' },
      chat: { id: chat, type },
    };
    await bot.handleUpdate({ update_id: updateId, message });
    return sent.slice(before);
  }
  return { bot, sent, purchases, users, refreshes, send };
}

test('normal /start is one short welcome, owner personalized; /help is full and explicit', async () => {
  const h = harness();
  const normal = await h.send('/start');
  assert.equal(normal.length, 1);
  assert.match(normal[0].data.text, /Здравей.*Ели/);
  assert.doesNotMatch(normal[0].data.text, /Профил|пробен период|планове/i);
  assert.deepEqual(h.users, [23456]);
  assert.equal((await h.send('/start', { from: 12345 }))[0].data.text.includes('Собственик'), true);
  assert.equal((await h.send('/start ordinary_payload')).length, 1);
  const help = await h.send('/help');
  assert.equal(help.length, 1);
  for (const cmd of ['/profile', '/plans', '/memory', '/addreminder', '/ping']) {
    assert.ok(help[0].data.text.includes(cmd));
  }
  assert.deepEqual(h.purchases, []);
});

test('all website buy deep links use trusted private Telegram identity, one URL only, no trial', async () => {
  const h = harness();
  for (const [payload, planId] of Object.entries(startCommands.BUY_PAYLOADS)) {
    const replies = await h.send(`/start ${payload}`);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].method, 'sendMessage');
    const buttons = replies[0].data.reply_markup.inline_keyboard;
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].length, 1);
    assert.equal(buttons[0][0].text, 'Confirm payment');
    assert.equal(buttons[0][0].url, `https://checkout.example/confirm-plan.html?session=${'A'.repeat(43)}`);
    assert.deepEqual(h.purchases.at(-1), { id: '23456', planId });
  }
  assert.deepEqual(h.users, []);
  assert.deepEqual(h.refreshes, []);
});

test('malformed buy payloads and group chats fail closed without purchase or trial', async () => {
  const h = harness();
  for (const payload of ['buy_unknown', 'buy_monthly%20evil', 'buy_monthly extra', 'buy:monthly', 'buy_', 'buy']) {
    const replies = await h.send(`/start ${payload}`);
    assert.equal(replies.length, 1);
    assert.match(replies[0].data.text, /\/plans/);
    assert.equal(replies[0].data.reply_markup, undefined);
  }
  const group = await h.send('/start buy_monthly', { chat: -100001, type: 'supergroup' });
  assert.equal(group.length, 1);
  assert.match(group[0].data.text, /личен чат/);
  assert.deepEqual(h.purchases, []);
  assert.deepEqual(h.users, []);
});

test('start, help, and payment_complete interrupt active scenes without erasing session memory', async () => {
  const h = harness();
  for (const command of ['/start buy_yearly', '/help', '/start payment_complete', '/start']) {
    await h.send('/wizard');
    const replies = await h.send(command);
    assert.equal(replies.length, 1);
    assert.notEqual(replies[0].data.text, 'Scene intercepted');
  }
  assert.deepEqual(h.refreshes, [23456]);
  assert.deepEqual(h.users, [23456]);
  assert.deepEqual(h.purchases, [{ id: '23456', planId: 'yearly' }]);
  assert.equal((await h.send('/inspect'))[0].data.text, 'kept');
  assert.equal((await h.send('hello')).length, 0);
});

test('purchase errors produce one short safe failure response and never create trial', async () => {
  const h = harness({ failPurchase: true });
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let replies;
  try {
    replies = await h.send('/start buy_monthly');
  } finally {
    console.warn = warn;
  }
  assert.equal(replies.length, 1);
  assert.equal(replies[0].data.text, plans.PURCHASE_ERROR_MESSAGE);
  assert.equal(replies[0].data.reply_markup, undefined);
  assert.equal(JSON.stringify(warnings).includes('sensitive'), false);
  assert.deepEqual(h.users, []);
});