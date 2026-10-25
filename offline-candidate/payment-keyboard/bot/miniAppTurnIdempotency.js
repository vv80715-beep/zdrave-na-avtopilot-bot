'use strict';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createMiniAppTurnCoordinator({ now = Date.now, ttlMs = 10 * 60_000, maxEntries = 1000 } = {}) {
  const entries = new Map();
  return function runMiniAppTurn({ userId, turnId, fingerprint, work }) {
    if (!/^[1-9]\d{4,19}$/.test(String(userId)) || !UUID_V4.test(turnId) ||
        typeof fingerprint !== 'string' || !fingerprint || typeof work !== 'function') {
      return Promise.reject(Object.assign(new Error('invalid_request'), { code: 'invalid_request' }));
    }
    const time = now();
    for (const [key, entry] of entries) {
      if (entry.settled && entry.expiresAt <= time) entries.delete(key);
    }
    const key = `${userId}:${turnId}`;
    const existing = entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(Object.assign(new Error('turn_id_conflict'), { code: 'turn_id_conflict' }));
      }
      return existing.promise;
    }
    if (entries.size >= maxEntries) {
      const oldest = [...entries].find(([, entry]) => entry.settled);
      if (oldest) entries.delete(oldest[0]);
      else return Promise.reject(Object.assign(new Error('turn_rate_limited'), { code: 'turn_rate_limited' }));
    }
    const entry = { fingerprint, settled: false, expiresAt: Number.POSITIVE_INFINITY, promise: null };
    entry.promise = Promise.resolve().then(work).then(
      (result) => {
        entry.settled = true;
        entry.expiresAt = now() + ttlMs;
        return result;
      },
      (error) => {
        entry.settled = true;
        entry.expiresAt = now() + ttlMs;
        throw error;
      },
    );
    entries.set(key, entry);
    return entry.promise;
  };
}

const runMiniAppTurn = createMiniAppTurnCoordinator();
module.exports = { createMiniAppTurnCoordinator, runMiniAppTurn };
