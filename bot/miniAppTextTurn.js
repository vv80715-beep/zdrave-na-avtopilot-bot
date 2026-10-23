'use strict';

const crypto = require('node:crypto');

function createCaptureContext(userId, message, updateId) {
  const replies = [];
  let media = null;
  const capture = async (text) => {
    if (typeof text === 'string' && text.trim()) replies.push(text);
  };
  return {
    from: { id: userId },
    chat: { type: 'private' },
    message: { text: message },
    update: { update_id: updateId },
    replies,
    get media() { return media; },
    reply: capture,
    replyWithMarkdown: capture,
    replyWithVoice: async (payload) => {
      const source = payload?.source;
      if (!Buffer.isBuffer(source) && !(source instanceof Uint8Array)) {
        throw new Error('mini_app_voice_payload_invalid');
      }
      media = {
        type: 'audio',
        mimeType: 'audio/ogg',
        data: Buffer.from(source).toString('base64'),
      };
    },
    replyWithVideo: async (payload) => {
      if (typeof payload?.url !== 'string' || !payload.url.startsWith('https://')) {
        throw new Error('mini_app_video_payload_invalid');
      }
      media = { type: 'video', url: payload.url };
    },
    sendChatAction: async () => {},
  };
}

function createMiniAppTextTurnHandler({
  isOwnerId,
  hasTextAIProvider,
  gateChat,
  askEli,
}) {
  if (![isOwnerId, hasTextAIProvider, gateChat, askEli].every((fn) => typeof fn === 'function')) {
    throw new TypeError('Mini App text-turn dependencies are required.');
  }

  return async function processMiniAppTextTurn({ userId, message, mode = 'text', turnId }) {
    const id = String(userId);
    if (!/^[1-9]\d{4,19}$/.test(id) || !isOwnerId(id)) {
      const error = new Error('owner_only');
      error.code = 'owner_only';
      throw error;
    }
    if (typeof message !== 'string' || !message.trim() || message.length > 1200) {
      const error = new Error('invalid_request');
      error.code = 'invalid_request';
      throw error;
    }
    if (!['text', 'voice', 'avatar'].includes(mode) ||
        typeof turnId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(turnId)) {
      const error = new Error('invalid_request');
      error.code = 'invalid_request';
      throw error;
    }
    if (!hasTextAIProvider(id)) {
      const error = new Error('text_ai_unavailable');
      error.code = 'text_ai_unavailable';
      throw error;
    }

    const digest = crypto.createHash('sha256').update(`${id}:${turnId}`).digest();
    const updateId = Number(digest.readBigUInt64BE(0) % BigInt(Number.MAX_SAFE_INTEGER - 1)) + 1;
    const ctx = createCaptureContext(id, message.trim(), updateId);
    const status = await gateChat(ctx);
    if (!status) {
      if (ctx.replies.length !== 1) throw new Error('text_turn_no_gate_reply');
      return { reply: ctx.replies[0], kind: 'access_denied' };
    }

    await askEli(ctx, message.trim(), {
      status,
      mode,
      rethrowProviderErrors: true,
    });
    if (ctx.media) {
      return {
        reply: ctx.media.type === 'audio' ? 'Гласов отговор от Ели.' : 'Видео отговор от Ели.',
        kind: ctx.media.type === 'audio' ? 'voice' : 'avatar',
        media: ctx.media,
      };
    }
    if (!ctx.replies.length) throw new Error('text_turn_invalid_delivery_count');
    return { reply: ctx.replies[ctx.replies.length - 1], kind: 'eli_text' };
  };
}

module.exports = { createMiniAppTextTurnHandler, createCaptureContext };
