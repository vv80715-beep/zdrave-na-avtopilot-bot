import { createHmac } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTelegramInitData } from '../src/lib/telegramInitData.mjs';

const TEST_BOT_TOKEN = 'offline-fake-token-never-used-for-telegram';
const NOW = 1_800_000_000;

function signedInitData({ userId = 123456789, authDate = NOW, queryId = 'offline-query' } = {}) {
  const fields = new URLSearchParams({
    auth_date: String(authDate),
    query_id: queryId,
    user: JSON.stringify({ id: userId, first_name: 'Offline test' }),
  });
  const checkString = [...fields.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(TEST_BOT_TOKEN).digest();
  const hash = createHmac('sha256', secretKey).update(checkString).digest('hex');
  fields.set('hash', hash);
  return fields.toString();
}

test('valid signed initData returns only the verified Telegram identity', () => {
  assert.deepEqual(
    validateTelegramInitData(signedInitData(), TEST_BOT_TOKEN, { nowSeconds: NOW }),
    {
      telegramUserId: '123456789',
      authDate: NOW,
      queryId: 'offline-query',
    },
  );
});

test('rejects forged or modified initData', () => {
  const forged = new URLSearchParams(signedInitData());
  forged.set('user', JSON.stringify({ id: 999999999, first_name: 'Forged' }));
  assert.throws(
    () => validateTelegramInitData(forged.toString(), TEST_BOT_TOKEN, { nowSeconds: NOW }),
    /Invalid Telegram Mini App initData/,
  );
});

test('rejects expired and implausibly future-dated auth_date values', () => {
  assert.throws(
    () => validateTelegramInitData(signedInitData({ authDate: NOW - 301 }), TEST_BOT_TOKEN, { nowSeconds: NOW }),
    /Invalid Telegram Mini App initData/,
  );
  assert.throws(
    () => validateTelegramInitData(signedInitData({ authDate: NOW + 31 }), TEST_BOT_TOKEN, { nowSeconds: NOW }),
    /Invalid Telegram Mini App initData/,
  );
});
