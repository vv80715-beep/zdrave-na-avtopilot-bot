const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 50_000;

function createTelegramUpdateIdempotency({
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const seen = new Map();

  return async function telegramUpdateIdempotency(ctx, next) {
    const updateId = ctx.update?.update_id;
    if (!Number.isSafeInteger(updateId) || updateId < 0) return next();

    const timestamp = now();
    for (const [id, seenAt] of seen) {
      if (timestamp - seenAt < ttlMs) break;
      seen.delete(id);
    }

    const key = String(updateId);
    if (seen.has(key)) return;

    // Claim synchronously before next() so concurrent deliveries cannot both
    // reach AI, billing, persistence, or reply handlers.
    seen.set(key, timestamp);
    while (seen.size > maxEntries) {
      seen.delete(seen.keys().next().value);
    }
    return next();
  };
}

module.exports = { createTelegramUpdateIdempotency };
