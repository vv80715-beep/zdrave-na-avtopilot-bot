const assert = require('node:assert/strict');
const test = require('node:test');
const { createMiniAppTextTurnHandler } = require('../miniAppTextTurn');

const OWNER = '123456789';

function setup({ provider = true, status = { canChat: true, allowedModes: ['text'] } } = {}) {
  const calls = [];
  const handler = createMiniAppTextTurnHandler({
    isOwnerId: id => id === OWNER,
    hasTextAIProvider: () => provider,
    gateChat: async ctx => {
      calls.push('gate');
      if (!status) {
        await ctx.reply('trial expired');
        return null;
      }
      return status;
    },
    askEli: async (ctx, message, options) => {
      calls.push({ message, forceTextDelivery: options.forceTextDelivery });
      await ctx.reply('synthetic Eli reply');
    },
  });
  return { handler, calls };
}

test('Mini App turn is owner-gated, uses the Telegram gate, and forces bot text delivery', async () => {
  const { handler, calls } = setup();
  const result = await handler({ userId: OWNER, message: 'synthetic prompt' });
  assert.deepEqual(result, { reply: 'synthetic Eli reply', kind: 'eli_text' });
  assert.deepEqual(calls, [
    'gate',
    { message: 'synthetic prompt', forceTextDelivery: true },
  ]);
  await assert.rejects(
    handler({ userId: '987654321', message: 'synthetic prompt' }),
    error => error.code === 'owner_only',
  );
});

test('expired access returns only the gate reply and never invokes the engine', async () => {
  const { handler, calls } = setup({ status: null });
  assert.deepEqual(
    await handler({ userId: OWNER, message: 'synthetic prompt' }),
    { reply: 'trial expired', kind: 'access_denied' },
  );
  assert.deepEqual(calls, ['gate']);
});

test('unavailable provider fails closed without an AI or demo fallback', async () => {
  const { handler, calls } = setup({ provider: false });
  await assert.rejects(
    handler({ userId: OWNER, message: 'synthetic prompt' }),
    error => error.code === 'text_ai_unavailable',
  );
  assert.deepEqual(calls, []);
});
