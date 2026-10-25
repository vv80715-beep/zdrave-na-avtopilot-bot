const test = require('node:test');
const assert = require('node:assert/strict');
const { Telegraf, Telegram, Scenes, session } = require('telegraf');
const startCommands = require('../commands/start');
const plans = require('../commands/plans');

function harness({ failPurchase = false, miniAppEnv, publicMiniAppEnv } = {}) {
  const bot = new Telegraf('123:offline');
  bot.botInfo = { id: 999, is_bot: true, first_name: 'Eli', username: 'EliTestBot' };
  const sent = [];
  const purchases = [];
  const users = [];
  const trials = new Map();
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
    ensureUser: (id) => {
      users.push(id);
      const key = String(id);
      if (!trials.has(key)) {
        trials.set(key, {
          trialStartedAt: 1000,
          trialExpiresAt: 1000 + 5 * 24 * 60 * 60 * 1000,
        });
      }
      return trials.get(key);
    },
    isOwner: (ctx) => ctx.from.id === 12345,
    ownerName: 'Собственик',
    purchasePlan: (ctx, planId) => plans.sendPurchaseLink(ctx, planId, client),
    miniAppStartMarkup: () =>
      startCommands.createMiniAppStartMarkup(miniAppEnv || {}),
    publicMiniAppStartMarkup: () =>
      startCommands.createPublicMiniAppStartMarkup(publicMiniAppEnv || {}),
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
  return { bot, sent, purchases, users, trials, refreshes, send };
}

test('normal /start is one short welcome, owner personalized; /help is full and explicit', async () => {
  const h = harness();
  const normal = await h.send('/start');
  assert.equal(normal.length, 1);
  assert.match(normal[0].data.text, /Здравей.*Ели/);
  assert.doesNotMatch(normal[0].data.text, /Профил|пробен период|планове/i);
  assert.equal(normal[0].data.reply_markup, undefined);
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

test('disabled Mini App flags restore the legacy /start conversation for owners and customers', async () => {
  const h = harness({
    miniAppEnv: {
      ELI_MINI_APP_START_BUTTON_ENABLED: 'false',
      ELI_MINI_APP_STAGE: 'staging',
      ELI_MINI_APP_URL: 'https://owner-stage.replit.dev/chat',
      NODE_ENV: 'development',
    },
    publicMiniAppEnv: {
      ELI_MINI_APP_PUBLIC_START_BUTTON_ENABLED: 'false',
      ELI_MINI_APP_PUBLIC_START_READY: 'false',
      ELI_MINI_APP_PUBLIC_URL: 'https://eli.example/chat',
      NODE_ENV: 'production',
    },
  });

  for (const from of [23456, 12345]) {
    const reply = await h.send('/start', { from });
    assert.equal(reply.length, 1);
    assert.equal(reply[0].data.reply_markup, undefined);
    assert.match(reply[0].data.text, /Здравей/);
  }
  assert.equal((await h.send('/help')).length, 1);
});

test('/plans remains the same static plan menu without creating a trial or purchase', async () => {
  const h = harness();
  const replies = await h.send('/plans');

  assert.equal(replies.length, 1);
  assert.match(replies[0].data.text, /7 days — €15/);
  const buttons = replies[0].data.reply_markup.inline_keyboard.map((row) => row[0]);
  assert.deepEqual(buttons.map((button) => button.callback_data), [
    'buy:seven_day',
    'buy:monthly',
    'buy:yearly',
  ]);
  assert.deepEqual(h.users, []);
  assert.deepEqual(h.purchases, []);
});

test('normal /start never shows Mini App buttons for owners or customers, even when enabled', async () => {
  assert.equal(startCommands.createMiniAppStartMarkup({}), undefined);
  assert.equal(startCommands.createMiniAppStartMarkup({
    ELI_MINI_APP_START_BUTTON_ENABLED: 'true',
    ELI_MINI_APP_STAGE: 'staging',
    ELI_MINI_APP_URL: 'http://eli.example.org/',
  }), undefined);
  assert.equal(startCommands.createMiniAppStartMarkup({
    ELI_MINI_APP_START_BUTTON_ENABLED: 'true',
    ELI_MINI_APP_STAGE: 'staging',
    ELI_MINI_APP_URL: 'https://localhost/',
  }), undefined);
  assert.equal(startCommands.createMiniAppStartMarkup({
    ELI_MINI_APP_START_BUTTON_ENABLED: 'true',
    ELI_MINI_APP_STAGE: 'staging',
    NODE_ENV: 'production',
    ELI_MINI_APP_URL: 'https://eli.replit.app/',
  }), undefined);

  const h = harness({
    miniAppEnv: {
      ELI_MINI_APP_START_BUTTON_ENABLED: 'true',
      ELI_MINI_APP_STAGE: 'staging',
      NODE_ENV: 'development',
      ELI_MINI_APP_URL: 'https://a8d764ea-44fd-403d-b30b-c4b99af8d5ca-00-139ynzw6poze2.worf.replit.dev/chat',
    },
    publicMiniAppEnv: {
      ELI_MINI_APP_PUBLIC_START_BUTTON_ENABLED: 'true',
      ELI_MINI_APP_PUBLIC_START_READY: 'true',
      NODE_ENV: 'production',
      ELI_MINI_APP_PUBLIC_URL: 'https://eli.replit.app/chat',
    },
  });

  for (const from of [23456, 12345]) {
    const start = await h.send('/start', { from });
    assert.equal(start.length, 1);
    assert.equal(start[0].data.reply_markup, undefined);
    assert.match(start[0].data.text, /Здравей/);
    assert.doesNotMatch(start[0].data.text, /Влез в Ели|WebApp/i);
  }

  const purchase = await h.send('/start buy_monthly');
  assert.equal(purchase[0].data.reply_markup.inline_keyboard[0][0].text, 'Confirm payment');
  assert.equal(purchase[0].data.reply_markup.inline_keyboard[0][0].web_app, undefined);

  const paymentComplete = await h.send('/start payment_complete');
  assert.equal(paymentComplete[0].data.text, 'Плащането е проверено.');
  assert.equal(paymentComplete[0].data.reply_markup, undefined);

  const group = await h.send('/start', { chat: -100002, type: 'supergroup' });
  assert.equal(group[0].data.reply_markup, undefined);
});

test('repeated normal /start preserves the original trial and sends no customer dev button', async () => {
  const h = harness({
    miniAppEnv: {
      ELI_MINI_APP_START_BUTTON_ENABLED: 'true',
      ELI_MINI_APP_STAGE: 'staging',
      NODE_ENV: 'development',
      ELI_MINI_APP_URL: 'https://owner-stage.replit.dev/chat',
    },
  });

  const first = await h.send('/start');
  const initialTrial = h.trials.get('23456');
  const second = await h.send('/start');

  assert.equal(first[0].data.reply_markup, undefined);
  assert.equal(second[0].data.reply_markup, undefined);
  assert.equal(h.users.length, 2);
  assert.equal(h.trials.size, 1);
  assert.equal(h.trials.get('23456').trialStartedAt, initialTrial.trialStartedAt);
  assert.equal(h.trials.get('23456').trialExpiresAt, initialTrial.trialExpiresAt);
});

test('public /start CTA is default-off and requires production readiness plus a safe stable URL', async () => {
  const disabled = {
    ELI_MINI_APP_PUBLIC_START_BUTTON_ENABLED: 'true',
    ELI_MINI_APP_PUBLIC_URL: 'https://eli.replit.app/chat',
    NODE_ENV: 'production',
  };
  assert.equal(startCommands.createPublicMiniAppStartMarkup(disabled), undefined);
  assert.equal(startCommands.createPublicMiniAppStartMarkup({
    ...disabled,
    ELI_MINI_APP_PUBLIC_START_READY: 'true',
    NODE_ENV: 'development',
  }), undefined);

  const ready = {
    ...disabled,
    ELI_MINI_APP_PUBLIC_START_READY: 'true',
  };
  const markup = startCommands.createPublicMiniAppStartMarkup(ready);
  assert.equal(markup.reply_markup.inline_keyboard.length, 1);
  assert.equal(markup.reply_markup.inline_keyboard[0].length, 1);
  assert.equal(markup.reply_markup.inline_keyboard[0][0].text, 'Влез в Ели');
  assert.deepEqual(markup.reply_markup.inline_keyboard[0][0].web_app, {
    url: 'https://eli.replit.app/chat',
  });

  for (const url of [
    'http://eli.example.org/chat',
    'https://eli.replit.dev/chat',
    'https://localhost/chat',
    'https://127.0.0.1/chat',
    'https://user:pass@eli.example.org/chat',
    'https://eli.example.org/chat?next=https://attacker.example',
    'https://eli.example.org/chat#redirect',
  ]) {
    assert.equal(startCommands.createPublicMiniAppStartMarkup({
      ...ready,
      ELI_MINI_APP_PUBLIC_URL: url,
    }), undefined, `should reject ${url}`);
  }
});

test('staging and public Mini App settings never expose a /start button', async () => {
  const h = harness({
    miniAppEnv: {
      ELI_MINI_APP_START_BUTTON_ENABLED: 'true',
      ELI_MINI_APP_STAGE: 'staging',
      NODE_ENV: 'development',
      ELI_MINI_APP_URL: 'https://owner-stage.replit.dev/chat',
    },
    publicMiniAppEnv: {},
  });
  for (const from of [23456, 12345]) {
    assert.equal((await h.send('/start', { from }))[0].data.reply_markup, undefined);
  }

  const publicH = harness({
    publicMiniAppEnv: {
      ELI_MINI_APP_PUBLIC_START_BUTTON_ENABLED: 'true',
      ELI_MINI_APP_PUBLIC_START_READY: 'true',
      ELI_MINI_APP_PUBLIC_URL: 'https://eli.replit.app/chat',
      NODE_ENV: 'production',
    },
  });
  for (const from of [23456, 12345]) {
    const reply = await publicH.send('/start', { from });
    assert.equal(reply[0].data.reply_markup, undefined);
  }
  const group = await publicH.send('/start', {
    from: 23456,
    chat: -100002,
    type: 'supergroup',
  });
  assert.equal(group[0].data.reply_markup, undefined);
});

test('buy and payment deep links never receive the public Web App CTA', async () => {
  const h = harness({
    publicMiniAppEnv: {
      ELI_MINI_APP_PUBLIC_START_BUTTON_ENABLED: 'true',
      ELI_MINI_APP_PUBLIC_START_READY: 'true',
      ELI_MINI_APP_PUBLIC_URL: 'https://eli.replit.app/chat',
      NODE_ENV: 'production',
    },
  });

  const purchase = await h.send('/start buy_monthly');
  const purchaseButton = purchase[0].data.reply_markup.inline_keyboard[0][0];
  assert.equal(purchaseButton.text, 'Confirm payment');
  assert.equal(purchaseButton.web_app, undefined);

  const paymentComplete = await h.send('/start payment_complete');
  assert.equal(paymentComplete[0].data.reply_markup, undefined);
  assert.equal(paymentComplete[0].data.text, 'Плащането е проверено.');
  assert.deepEqual(h.users, []);
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