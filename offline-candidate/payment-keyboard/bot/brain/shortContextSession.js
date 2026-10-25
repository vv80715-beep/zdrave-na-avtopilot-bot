'use strict';

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map();

function normalizeUserId(userId) {
  if (userId === undefined || userId === null || String(userId).trim() === '') {
    throw new TypeError('short context requires a user id');
  }
  return String(userId);
}

function prune(userId, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const key = normalizeUserId(userId);
  const items = sessions.get(key) || [];
  const kept = items.filter((item) => now - item.at <= ttlMs);
  if (kept.length) sessions.set(key, kept);
  else sessions.delete(key);
  return kept;
}

function getShortContext(userId, options = {}) {
  const maxTurns = options.maxTurns || DEFAULT_MAX_TURNS;
  const items = prune(userId, options.now || Date.now(), options.ttlMs || DEFAULT_TTL_MS);
  return items.slice(-maxTurns).map(({ role, content }) => ({ role, content }));
}

function rememberShortTurn(userId, role, content, options = {}) {
  if (role !== 'user' && role !== 'assistant') throw new RangeError('invalid short context role');
  const text = String(content || '').trim();
  if (!text) return getShortContext(userId, options);
  const key = normalizeUserId(userId);
  const now = options.now || Date.now();
  const maxTurns = options.maxTurns || DEFAULT_MAX_TURNS;
  const items = prune(key, now, options.ttlMs || DEFAULT_TTL_MS);
  items.push({ role, content: text.slice(0, 480), at: now });
  sessions.set(key, items.slice(-maxTurns));
  return getShortContext(key, options);
}

function clearShortContext(userId) {
  sessions.delete(normalizeUserId(userId));
}

module.exports = {
  DEFAULT_MAX_TURNS,
  DEFAULT_TTL_MS,
  getShortContext,
  rememberShortTurn,
  clearShortContext,
};
