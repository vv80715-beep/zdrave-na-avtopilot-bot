const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Telegraf } = require('telegraf');
const { createTelegramUpdateIdempotency } = require('../telegramUpdateIdempotency');

test('the real bot registers update dedupe before session and user handlers', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const dedupe = source.indexOf('bot.use(createTelegramUpdateIdempotency());');
  const session = source.indexOf('bot.use(session());');
  assert.ok(dedupe >= 0 && dedupe < session);
});

test('concurrent and sequential redelivery calls mock AI and sends one reply only', async () => {
  const bot = new Telegraf('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi');
  bot.use(createTelegramUpdateIdempotency());

  let providerCalls = 0;
  const visibleReplies = [];
  bot.telegram.callApi = async (method, payload) => {
    assert.equal(method, 'sendMessage');
    visibleReplies.push(payload.text);
    return { message_id: 77, chat: { id: payload.chat_id } };
  };

  bot.on('text', async (ctx) => {
    providerCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await ctx.reply('synthetic AI answer');
  });

  const update = {
    update_id: 88000001,
    message: {
      message_id: 880001,
      date: 1_800_000_000,
      from: { id: 990000001, is_bot: false, first_name: 'Synthetic' },
      chat: { id: 990000001, type: 'private' },
      text: 'synthetic prompt',
    },
  };

  await Promise.all([bot.handleUpdate(update), bot.handleUpdate(update)]);
  await bot.handleUpdate(update);

  assert.equal(providerCalls, 1);
  assert.deepEqual(visibleReplies, ['synthetic AI answer']);

  const distinctUpdate = structuredClone(update);
  distinctUpdate.update_id += 1;
  distinctUpdate.message.message_id += 1;
  await bot.handleUpdate(distinctUpdate);

  assert.equal(providerCalls, 2);
  assert.deepEqual(visibleReplies, ['synthetic AI answer', 'synthetic AI answer']);
});
