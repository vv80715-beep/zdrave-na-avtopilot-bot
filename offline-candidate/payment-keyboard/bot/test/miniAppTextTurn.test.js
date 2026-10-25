const assert = require('node:assert/strict');
const test = require('node:test');
const { createMiniAppTextTurnHandler } = require('../miniAppTextTurn');
const { createMiniAppTurnCoordinator } = require('../miniAppTurnIdempotency');

const OWNER = '123456789';

function setup({ provider = true, status = { canChat: true, allowedModes: ['text'] } } = {}) {
  const calls = [];
  const handler = createMiniAppTextTurnHandler({
    runTurn: createMiniAppTurnCoordinator(),
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
      calls.push({ message, mode: options.mode });
      await ctx.reply('synthetic Eli reply');
    },
  });
  return { handler, calls };
}

test('Mini App turn uses the per-user Telegram gate and forces bot text delivery', async () => {
  const { handler, calls } = setup();
  const turnId = 'f9b2d7a0-0e22-4e10-a987-7eea4ebf0667';
  const result = await handler({ userId: OWNER, message: 'synthetic prompt', mode: 'text', turnId });
  assert.deepEqual(result, { reply: 'synthetic Eli reply', kind: 'eli_text' });
  assert.deepEqual(calls, [
    'gate',
    { message: 'synthetic prompt', mode: 'text' },
  ]);
  const customer = await handler({ userId: '987654321', message: 'synthetic customer prompt', mode: 'text', turnId });
  assert.deepEqual(customer, { reply: 'synthetic Eli reply', kind: 'eli_text' });
  assert.deepEqual(calls.slice(-2), [
    'gate',
    { message: 'synthetic customer prompt', mode: 'text' },
  ]);
});

test('expired access returns only the gate reply and never invokes the engine', async () => {
  const { handler, calls } = setup({ status: null });
  assert.deepEqual(
    await handler({ userId: OWNER, message: 'synthetic prompt', mode: 'text', turnId: 'f9b2d7a0-0e22-4e10-a987-7eea4ebf0667' }),
    { reply: 'trial expired', kind: 'access_denied' },
  );
  assert.deepEqual(calls, ['gate']);
});

test('unavailable provider fails closed without an AI or demo fallback', async () => {
  const { handler, calls } = setup({ provider: false });
  await assert.rejects(
    handler({ userId: OWNER, message: 'synthetic prompt', mode: 'text', turnId: 'f9b2d7a0-0e22-4e10-a987-7eea4ebf0667' }),
    error => error.code === 'text_ai_unavailable',
  );
  assert.deepEqual(calls, ['gate']);
});

test('voice and avatar payloads are captured for Mini App playback without Telegram delivery', async () => {
  const turnId = 'f9b2d7a0-0e22-4e10-a987-7eea4ebf0667';
  const captured = [];
  const handler = createMiniAppTextTurnHandler({
    runTurn: createMiniAppTurnCoordinator(),
    hasTextAIProvider: () => true,
    gateChat: async () => ({ canChat: true, allowedModes: ['text', 'voice', 'avatar'] }),
    askEli: async (ctx, _message, options) => {
      captured.push({ mode: options.mode, updateId: ctx.update.update_id });
      ctx.captureText('Синтетичен отговор в текста.');
      if (options.mode === 'voice') {
        await ctx.replyWithVoice({ source: Buffer.from('synthetic-audio') });
      } else {
        await ctx.reply('intermediate progress');
        await ctx.replyWithVideo({ url: 'https://media.example/synthetic.mp4' });
      }
    },
  });

  const voice = await handler({ userId: OWNER, message: 'say hello', mode: 'voice', turnId });
  assert.equal(voice.kind, 'voice');
  assert.equal(voice.reply, 'Синтетичен отговор в текста.');
  assert.deepEqual(voice.media, {
    type: 'audio',
    mimeType: 'audio/ogg',
    data: Buffer.from('synthetic-audio').toString('base64'),
  });
  const video = await handler({
    userId: OWNER, message: 'say hello', mode: 'avatar',
    turnId: 'cbe7a061-850d-44bc-9b75-8d78045b88f4',
  });
  assert.equal(video.kind, 'avatar');
  assert.equal(video.reply, 'Синтетичен отговор в текста.');
  assert.deepEqual(video.media, { type: 'video', url: 'https://media.example/synthetic.mp4' });
  assert.notEqual(captured[0].updateId, captured[1].updateId);
});

test('text-only trial cannot invoke a paid voice or avatar mode', async () => {
  let aiCalls = 0;
  const handler = createMiniAppTextTurnHandler({
    runTurn: createMiniAppTurnCoordinator(),
    hasTextAIProvider: () => true,
    gateChat: async () => ({ canChat: true, allowedModes: ['text'] }),
    askEli: async () => { aiCalls += 1; },
  });
  for (const mode of ['voice', 'avatar']) {
    const result = await handler({
      userId: OWNER,
      message: 'synthetic request',
      mode,
      turnId: mode === 'voice' ? 'cbe7a061-850d-44bc-9b75-8d78045b88f4' : '22fa9e42-f07d-4157-927e-121f5664afcc',
    });
    assert.equal(result.kind, 'access_denied');
  }
  assert.equal(aiCalls, 0);
});
