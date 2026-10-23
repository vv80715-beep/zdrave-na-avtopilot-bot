'use strict';

const crypto = require('node:crypto');
const { createCaptureContext } = require('./miniAppTextTurn');
const { runMiniAppTurn } = require('./miniAppTurnIdempotency');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createMiniAppVoiceTurnHandler({
  gateChat,
  hasTextAIProvider,
  transcribeAudioBuffer,
  looksLikeBulgarian,
  askEli,
  isOwnerId,
  runTurn = runMiniAppTurn,
}) {
  if (![gateChat, hasTextAIProvider, transcribeAudioBuffer, looksLikeBulgarian, askEli, isOwnerId, runTurn]
    .every((fn) => typeof fn === 'function')) {
    throw new TypeError('Mini App voice-turn dependencies are required.');
  }

  async function executeMiniAppVoiceTurn({ userId, audio, mode = 'text', turnId, prompt = '' }) {
    const id = String(userId);
    if (!/^[1-9]\d{4,19}$/.test(id) || !Buffer.isBuffer(audio) ||
        audio.length < 44 || audio.length > 4 * 1024 * 1024 ||
        audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE' ||
        !['text', 'voice', 'avatar'].includes(mode) || !UUID_V4.test(turnId) ||
        typeof prompt !== 'string' || prompt.length > 1200) {
      const error = new Error('invalid_request');
      error.code = 'invalid_request';
      throw error;
    }

    const digest = crypto.createHash('sha256').update(`${id}:${turnId}`).digest();
    const updateId = Number(digest.readBigUInt64BE(0) % BigInt(Number.MAX_SAFE_INTEGER - 1)) + 1;
    const ctx = createCaptureContext(id, '[voice message]', updateId);
    const status = await gateChat(ctx);
    if (!status) {
      return { transcript: '', reply: ctx.replies.at(-1) || 'Чатът не е достъпен.', kind: 'access_denied' };
    }
    if (!isOwnerId(id) && !status.allowedModes?.includes('voice')) {
      return {
        transcript: '',
        reply: 'Гласовият вход е достъпен с активен план за глас. Провери плана си в бота на Ели.',
        kind: 'access_denied',
      };
    }
    if (!hasTextAIProvider(id)) {
      const error = new Error('text_ai_unavailable');
      error.code = 'text_ai_unavailable';
      throw error;
    }

    const transcript = await transcribeAudioBuffer(audio);
    if (!looksLikeBulgarian(transcript)) {
      return {
        transcript: transcript || '',
        reply: 'Не успях да разбера добре гласовото. Можеш ли да го кажеш пак по-ясно?',
        kind: 'transcription_unclear',
      };
    }
    const message = prompt.trim() ? `${transcript}\n\n${prompt.trim()}` : transcript;
    ctx.message.text = message;
    await askEli(ctx, message, {
      status, mode, spokenInput: true, rethrowProviderErrors: true, captureTextReply: true,
    });
    if (ctx.media) {
      return {
        transcript,
        reply: ctx.textReply || (ctx.media.type === 'audio' ? 'Гласов отговор от Ели.' : 'Видео отговор от Ели.'),
        kind: ctx.media.type === 'audio' ? 'voice' : 'avatar',
        media: ctx.media,
      };
    }
    if (!ctx.replies.length) throw new Error('voice_turn_invalid_delivery_count');
    return { transcript, reply: ctx.replies.at(-1), kind: 'eli_text' };
  }

  return function processMiniAppVoiceTurn(input) {
    const audio = Buffer.isBuffer(input.audio) ? input.audio : Buffer.alloc(0);
    const fingerprint = crypto.createHash('sha256')
      .update(audio)
      .update(JSON.stringify([input.mode || 'text', input.prompt || '']))
      .digest('hex');
    return runTurn({
      userId: input.userId,
      turnId: input.turnId,
      fingerprint: `voice:${fingerprint}`,
      work: () => executeMiniAppVoiceTurn(input),
    });
  };
}

module.exports = { createMiniAppVoiceTurnHandler };
