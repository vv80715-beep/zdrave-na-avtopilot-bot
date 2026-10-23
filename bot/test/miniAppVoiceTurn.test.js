'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMiniAppVoiceTurnHandler } = require('../miniAppVoiceTurn');
const { createMiniAppTurnCoordinator } = require('../miniAppTurnIdempotency');

const TURN_ID = 'f9b2d7a0-0e22-4e10-a987-7eea4ebf0667';
const AUDIO = Buffer.concat([
  Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(36),
]);

function makeHandler({
  status = { canChat: true, allowedModes: ['text', 'voice'] },
  owner = false,
  transcript = 'Искам да се разходя.',
  ask = async (ctx) => ctx.reply('Синтетичен отговор.'),
  transcribe = async () => transcript,
  provider = true,
} = {}) {
  const calls = [];
  const handler = createMiniAppVoiceTurnHandler({
    runTurn: createMiniAppTurnCoordinator(),
    gateChat: async (ctx) => { calls.push('gate'); return status; },
    hasTextAIProvider: () => { calls.push('provider'); return provider; },
    transcribeAudioBuffer: async (audio) => { calls.push(['transcribe', audio]); return transcribe(); },
    looksLikeBulgarian: (text) => /[А-Яа-я]/.test(text),
    askEli: async (ctx, text, options) => { calls.push(['ask', text, options.mode]); await ask(ctx, text, options); },
    isOwnerId: () => owner,
  });
  return { handler, calls };
}

test('voice turn gates voice entitlement before transcription and passes the verified user to Eli', async () => {
  const { handler, calls } = makeHandler();
  const result = await handler({
    userId: '987654321', audio: AUDIO, mode: 'text', turnId: TURN_ID, prompt: 'моля, кратко',
  });
  assert.deepEqual(result, {
    transcript: 'Искам да се разходя.',
    reply: 'Синтетичен отговор.',
    kind: 'eli_text',
  });
  assert.equal(calls[0], 'gate');
  assert.equal(calls[1], 'provider');
  assert.deepEqual(calls[2], ['transcribe', AUDIO]);
  assert.equal(calls[3][1], 'Искам да се разходя.\n\nмоля, кратко');
});

test('expired plan and text-only plan never invoke transcription or AI', async () => {
  const expired = makeHandler({ status: null });
  assert.deepEqual(await expired.handler({
    userId: '987654321', audio: AUDIO, turnId: TURN_ID,
  }), { transcript: '', reply: 'Чатът не е достъпен.', kind: 'access_denied' });
  assert.deepEqual(expired.calls, ['gate']);

  const textOnly = makeHandler({ status: { canChat: true, allowedModes: ['text'] } });
  assert.equal((await textOnly.handler({
    userId: '987654321', audio: AUDIO, turnId: TURN_ID,
  })).kind, 'access_denied');
  assert.deepEqual(textOnly.calls, ['gate']);
});

test('voice recording submitted in avatar mode requires both voice and avatar entitlement before STT', async () => {
  const restricted = makeHandler({
    status: { canChat: true, allowedModes: ['text', 'voice'] },
  });
  const result = await restricted.handler({
    userId: '987654321', audio: AUDIO, mode: 'avatar', turnId: TURN_ID,
  });
  assert.equal(result.kind, 'access_denied');
  assert.deepEqual(restricted.calls, ['gate']);
});

test('owner voice input and voice output are captured without Telegram delivery', async () => {
  const owner = makeHandler({
    owner: true,
    status: { canChat: true, allowedModes: ['text'] },
    ask: async (ctx) => ctx.replyWithVoice({ source: Buffer.from('synthetic-ogg') }),
  });
  const result = await owner.handler({
    userId: '123456789', audio: AUDIO, mode: 'voice', turnId: TURN_ID,
  });
  assert.equal(result.kind, 'voice');
  assert.deepEqual(result.media, {
    type: 'audio', mimeType: 'audio/ogg',
    data: Buffer.from('synthetic-ogg').toString('base64'),
  });
});

test('invalid normalized audio is rejected before gate or provider work', async () => {
  const { handler, calls } = makeHandler();
  await assert.rejects(handler({
    userId: '987654321', audio: Buffer.from('not wav'), turnId: TURN_ID,
  }), (error) => error.code === 'invalid_request');
  assert.deepEqual(calls, []);
});

test('provider failure is surfaced and does not fall back to demo content', async () => {
  const { handler, calls } = makeHandler({
    transcribe: async () => { throw new Error('mock transcription failure'); },
  });
  await assert.rejects(handler({
    userId: '987654321', audio: AUDIO, turnId: TURN_ID,
  }), /mock transcription failure/);
  assert.deepEqual(calls.slice(0, 3), ['gate', 'provider', ['transcribe', AUDIO]]);
});
