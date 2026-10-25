// Diagnostics only. Never retain/log provider bodies, IDs, URLs or user text.
const { randomUUID } = require('node:crypto');
const REASONS = new Set([
  'provider_billing', 'provider_auth', 'provider_rate_limit', 'provider_unavailable',
  'invalid_avatar', 'invalid_voice', 'provider_rejected', 'timeout', 'network_error',
  'provider_generation_failed', 'missing_video_id', 'unknown',
]);

function providerReason(status, body) {
  const error = body?.error;
  const code = typeof error?.code === 'string' ? error.code.toLowerCase() : '';
  // Only recognized structured codes are interpreted; raw messages are never logged.
  if (['avatar_not_found', 'invalid_avatar', 'invalid_avatar_id'].includes(code)) return 'invalid_avatar';
  if (['voice_not_found', 'invalid_voice', 'invalid_voice_id'].includes(code)) return 'invalid_voice';
  if (status === 402 || ['insufficient_credit', 'insufficient_credits', 'insufficient_balance'].includes(code))
    return 'provider_billing';
  if (status === 401 || status === 403) return 'provider_auth';
  if (status === 429) return 'provider_rate_limit';
  if (status >= 500) return 'provider_unavailable';
  return 'provider_rejected';
}

function safeError(error, stage) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const match = /^HeyGen (?:generate|status): HTTP (\d{3})$/.exec(message);
  const httpStatus = match ? Number(match[1]) : undefined;
  let reason = REASONS.has(error?.avatarReason) ? error.avatarReason : 'unknown';
  if (reason === 'unknown' && httpStatus) reason = providerReason(httpStatus);
  if (reason === 'unknown' && (/^HeyGen (?:generate|status): request timeout$/.test(message) ||
      message === 'HeyGen video generation timed out.')) reason = 'timeout';
  if (/^HeyGen (?:generate|status): network error$/.test(message)) reason = 'network_error';
  if (message === 'HeyGen video failed: generation error') reason = 'provider_generation_failed';
  if (message === 'HeyGen did not return a video_id.') reason = 'missing_video_id';
  if (stage === 'telegram_video') reason = 'telegram_send_video_failed';
  if (stage === 'telegram_action') reason = 'telegram_chat_action_failed';
  const telegramStatus = stage.startsWith('telegram_') &&
    Number.isInteger(error?.response?.error_code) ? error.response.error_code : undefined;
  return { reason, ...(httpStatus ? { httpStatus } : {}),
    ...(telegramStatus ? { telegramStatus } : {}) };
}

function createAvatarTrace() {
  const correlationId = randomUUID(); // Not a Telegram/user/provider identifier.
  return {
    stage: 'configuration', delivered: false, reason: undefined, error: undefined,
    finish() {
      try {
        console.info('Avatar diagnostic', {
          correlationId, stage: this.stage,
          outcome: this.delivered ? 'video_delivered' : 'text_fallback',
          ...(this.error ? safeError(this.error, this.stage) :
            { reason: this.reason || (this.delivered ? 'success' : 'stage_not_passed') }),
        });
      } catch (_) { /* logging must never affect delivery/accounting */ }
    },
  };
}

module.exports = { providerReason, safeError, createAvatarTrace };