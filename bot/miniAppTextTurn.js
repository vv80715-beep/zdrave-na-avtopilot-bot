'use strict';

function createCaptureContext(userId, message) {
  const replies = [];
  const capture = async (text) => {
    if (typeof text === 'string' && text.trim()) replies.push(text);
  };
  return {
    from: { id: userId },
    chat: { type: 'private' },
    message: { text: message },
    replies,
    reply: capture,
    replyWithMarkdown: capture,
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

  return async function processMiniAppTextTurn({ userId, message }) {
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
    if (!hasTextAIProvider(id)) {
      const error = new Error('text_ai_unavailable');
      error.code = 'text_ai_unavailable';
      throw error;
    }

    const ctx = createCaptureContext(id, message.trim());
    const status = await gateChat(ctx);
    if (!status) {
      if (ctx.replies.length !== 1) throw new Error('text_turn_no_gate_reply');
      return { reply: ctx.replies[0], kind: 'access_denied' };
    }

    await askEli(ctx, message.trim(), {
      status,
      forceTextDelivery: true,
      rethrowProviderErrors: true,
    });
    if (ctx.replies.length !== 1) throw new Error('text_turn_invalid_delivery_count');
    return { reply: ctx.replies[0], kind: 'eli_text' };
  };
}

module.exports = { createMiniAppTextTurnHandler, createCaptureContext };
