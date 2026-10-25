import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_INIT_DATA_LENGTH = 16_384;
const DEFAULT_MAX_AGE_SECONDS = 300;
const DEFAULT_FUTURE_SKEW_SECONDS = 30;

function invalid() {
  return new Error('Invalid Telegram Mini App initData.');
}

/**
 * Validates raw Telegram.WebApp.initData without trusting any client-side
 * decoded user object. The bot token must be passed by a server-only caller.
 */
export function validateTelegramInitData(rawInitData, botToken, options = {}) {
  if (
    typeof rawInitData !== 'string' ||
    rawInitData.length === 0 ||
    rawInitData.length > MAX_INIT_DATA_LENGTH ||
    typeof botToken !== 'string' ||
    botToken.length === 0
  ) {
    throw invalid();
  }

  const params = new URLSearchParams(rawInitData);
  const fields = [...params.entries()];
  const seen = new Set();
  for (const [key] of fields) {
    if (seen.has(key)) throw invalid();
    seen.add(key);
  }

  const receivedHash = params.get('hash');
  const authDateText = params.get('auth_date');
  const userText = params.get('user');
  if (
    !receivedHash ||
    !/^[\da-f]{64}$/i.test(receivedHash) ||
    !authDateText ||
    !/^\d+$/.test(authDateText) ||
    !userText
  ) {
    throw invalid();
  }

  const authDate = Number(authDateText);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const futureSkewSeconds = options.futureSkewSeconds ?? DEFAULT_FUTURE_SKEW_SECONDS;
  if (
    !Number.isSafeInteger(authDate) ||
    !Number.isFinite(nowSeconds) ||
    nowSeconds - authDate > maxAgeSeconds ||
    authDate - nowSeconds > futureSkewSeconds
  ) {
    throw invalid();
  }

  let user;
  try {
    user = JSON.parse(userText);
  } catch {
    throw invalid();
  }
  const rawUserId = user?.id;
  const telegramUserId =
    typeof rawUserId === 'number' && Number.isSafeInteger(rawUserId) && rawUserId > 0
      ? String(rawUserId)
      : typeof rawUserId === 'string' && /^[1-9]\d{0,19}$/.test(rawUserId)
        ? rawUserId
        : null;
  if (!telegramUserId) throw invalid();

  const dataCheckString = fields
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest();
  const actualHash = Buffer.from(receivedHash, 'hex');
  if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
    throw invalid();
  }

  return {
    telegramUserId,
    authDate,
    queryId: params.get('query_id') || null,
  };
}
