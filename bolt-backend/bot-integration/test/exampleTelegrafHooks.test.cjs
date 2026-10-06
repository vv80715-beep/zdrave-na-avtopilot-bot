'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  registerPurchaseActions,
  handleStartMessage,
  createModeGuard,
} = require('../example-telegraf-hooks.cjs');

test('registered plan action replies with the server-generated purchase URL', async () => {
  const handlers = new Map();
  const bot = { action: (name, handler) => handlers.set(name, handler) };
  registerPurchaseActions({
    bot,
    client: {
      createPurchaseSession: async ({ planId }) => ({
        purchaseUrl: `https://eli.example/confirm-plan.html?session=${planId}${'A'.repeat(40)}`,
        expiresAt: new Date('2026-08-19T10:00:00.000Z'),
        plan: { id: planId },
      }),
    },
    logger: { error: () => {} },
  });

  let reply;
  const ctx = {
    from: { id: 8934490753 },
    answerCbQuery: async () => {},
    reply: async (text, extra) => { reply = { text, extra }; },
  };
  await handlers.get('buy:monthly')(ctx);
  assert.match(reply.text, /месечния план/);
  assert.match(reply.extra.reply_markup.inline_keyboard[0][0].url, /confirm-plan\.html\?session=/);
});

test('payment_complete start payload forces resolver refresh', async () => {
  let refreshes = 0;
  let reply;
  const ctx = {
    from: { id: 8934490753 },
    message: { text: '/start payment_complete' },
    reply: async (text, extra) => { reply = { text, extra }; },
  };
  const result = await handleStartMessage({
    ctx,
    client: {},
    resolver: {
      refreshAfterPayment: async () => {
        refreshes += 1;
        return {
          active: true,
          paid: true,
          backendVerified: true,
          chatModes: ['text', 'voice'],
          expiresAt: new Date('2026-08-26T09:00:00.000Z'),
        };
      },
    },
    getLocalAccess: async () => ({ state: 'trial' }),
  });
  assert.equal(result.handled, true);
  assert.equal(refreshes, 1);
  assert.match(reply.text, /планът ти е активен/);
});

test('mode guard blocks paid API path before next when verification fails', async () => {
  let nextCalls = 0;
  let deniedText = '';
  const guard = createModeGuard({
    resolver: {
      checkMode: async () => ({ allowed: false, code: 'paid_verification_unavailable', access: {} }),
    },
    mode: 'avatar',
  });
  await guard({
    from: { id: 8934490753 },
    reply: async (text) => { deniedText = text; },
  }, async () => { nextCalls += 1; });
  assert.equal(nextCalls, 0);
  assert.match(deniedText, /не стартирам платена заявка/i);
});
