'use strict';

function parseAllowlist(value) {
  if (Array.isArray(value)) return new Set(value.map(String));
  return new Set(
    String(value || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  );
}

function createCanaryReadRouter(options = {}) {
  const allowlist = parseAllowlist(options.allowlist);
  const durableReader = options.durableReader;
  const legacyReader = options.legacyReader;
  const diagnostics = options.diagnostics || (() => {});

  if (typeof legacyReader !== 'function') throw new TypeError('legacyReader is required');

  return {
    isAllowlisted(userId) {
      return allowlist.has(String(userId));
    },

    async read(userId) {
      const id = String(userId);
      if (!allowlist.has(id) || typeof durableReader !== 'function') {
        return { source: 'legacy', data: await legacyReader(id) };
      }

      let durable;
      try {
        durable = await durableReader(id);
      } catch (error) {
        diagnostics({ type: 'durable_read_error', telegramUserId: id, message: error.message });
        return { source: 'legacy_fallback', data: await legacyReader(id) };
      }

      const legacy = await legacyReader(id);
      if (JSON.stringify(durable) !== JSON.stringify(legacy)) {
        diagnostics({ type: 'durable_mismatch', telegramUserId: id });
        return { source: 'legacy_fallback', data: legacy };
      }

      return { source: 'durable_canary', data: durable };
    },
  };
}

module.exports = { parseAllowlist, createCanaryReadRouter };
