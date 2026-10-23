'use strict';

const crypto = require('crypto');

const CLAIM_PATH = '/internal/mini-app/profile-snapshot';
const TEXT_TURN_PATH = '/internal/mini-app/text-turn';
const MUTATION_PATH = '/internal/mini-app/mutate';
const CLAIM_PATHS = new Set([CLAIM_PATH, TEXT_TURN_PATH, MUTATION_PATH]);
const CLOCK_SKEW_SECONDS = 30;

function bridgeKey(secret) {
  if (typeof secret !== 'string' || secret.trim().length < 32) {
    throw new Error('mini_app_bridge_unavailable');
  }
  return crypto.createHmac('sha256', secret)
    .update('eli-mini-app-bot-bridge-v1')
    .digest();
}

function signature(payload, secret) {
  return crypto.createHmac('sha256', bridgeKey(secret)).update(payload).digest('base64url');
}

function createClaim(userId, secret, nowSeconds = Math.floor(Date.now() / 1000), path = CLAIM_PATH) {
  if (!/^[1-9]\d{4,19}$/.test(String(userId))) {
    throw new Error('mini_app_bridge_invalid_user');
  }
  if (!CLAIM_PATHS.has(path)) throw new Error('mini_app_bridge_invalid_path');
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    sub: String(userId),
    path,
    iat: nowSeconds,
    nonce: crypto.randomBytes(18).toString('base64url'),
  })).toString('base64url');
  return `${payload}.${signature(payload, secret)}`;
}

function verifyClaim(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [payload, supplied, extra] = token.split('.');
  if (!payload || !supplied || extra) return null;
  let expected;
  try {
    expected = Buffer.from(signature(payload, secret));
  } catch {
    return null;
  }
  const actual = Buffer.from(supplied);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (claims.v !== 1 || !CLAIM_PATHS.has(claims.path) ||
        !/^[1-9]\d{4,19}$/.test(claims.sub) ||
        !Number.isInteger(claims.iat) ||
        Math.abs(nowSeconds - claims.iat) > CLOCK_SKEW_SECONDS ||
        typeof claims.nonce !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(claims.nonce)) return null;
    return { userId: claims.sub, nonce: claims.nonce, path: claims.path };
  } catch {
    return null;
  }
}

module.exports = { CLAIM_PATH, TEXT_TURN_PATH, MUTATION_PATH, createClaim, verifyClaim };
