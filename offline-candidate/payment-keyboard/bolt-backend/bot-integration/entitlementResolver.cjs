'use strict';

const { MODE_IDS, normalizeTelegramUserId, normalizeMode } = require('./eliPlatformClient.cjs');

const CHAT_MODES = Object.freeze(['text', 'voice', 'avatar']);

function normalizeModes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeMode).filter(Boolean))];
}

function normalizeLocalAccess(value = {}) {
  const expiresAt = value.expiresAt ? new Date(value.expiresAt) : null;
  return {
    active: Boolean(value.active),
    planId: String(value.planId || 'free'),
    state: String(value.state || (value.active ? 'trial' : 'inactive')),
    modes: normalizeModes(value.modes),
    expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
    hadPaidPlan: Boolean(value.hadPaidPlan),
  };
}

function toEffectivePaidAccess(entitlement, { source = 'paid_backend', backendVerified = true } = {}) {
  const modes = normalizeModes(entitlement?.modes);
  return {
    source,
    backendVerified,
    active: Boolean(entitlement?.active),
    paid: true,
    planId: entitlement?.planId || null,
    plan: entitlement?.plan || null,
    state: entitlement?.active ? 'paid' : 'paid_expired',
    modes,
    chatModes: modes.filter((mode) => CHAT_MODES.includes(mode)),
    expiresAt: entitlement?.expiresAt || null,
    avatarMinutesPerMonth: entitlement?.avatarMinutesPerMonth || 0,
    billingStatus: entitlement?.billingStatus || null,
    cancelAtPeriodEnd: Boolean(entitlement?.cancelAtPeriodEnd),
    reason: entitlement?.active ? null : 'paid_access_inactive',
  };
}

function toEffectiveLocalAccess(localAccess, now = new Date()) {
  const local = normalizeLocalAccess(localAccess);
  const notExpired = !local.expiresAt || local.expiresAt.getTime() > now.getTime();
  const active = local.active && notExpired && !local.hadPaidPlan;
  const modes = active ? local.modes.filter((mode) => mode === 'text') : [];
  return {
    source: active ? 'local_trial' : 'local_inactive',
    backendVerified: false,
    active,
    paid: false,
    planId: local.planId,
    plan: null,
    state: active ? local.state : (local.hadPaidPlan ? 'paid_expired' : 'inactive'),
    modes,
    chatModes: modes.filter((mode) => CHAT_MODES.includes(mode)),
    expiresAt: local.expiresAt,
    avatarMinutesPerMonth: 0,
    billingStatus: null,
    cancelAtPeriodEnd: false,
    reason: active ? null : (local.hadPaidPlan ? 'no_second_trial_after_paid' : 'local_access_inactive'),
  };
}

function modeDecision(access, requestedMode) {
  const mode = normalizeMode(requestedMode);
  if (!mode || !CHAT_MODES.includes(mode)) {
    return { allowed: false, code: 'invalid_mode', access };
  }
  if (!access?.active) {
    return { allowed: false, code: access?.reason || 'access_inactive', access };
  }
  if (!access.modes.includes(mode)) {
    return { allowed: false, code: 'mode_not_in_plan', access };
  }
  if ((mode === 'voice' || mode === 'avatar') && !access.backendVerified) {
    return { allowed: false, code: 'paid_verification_required', access };
  }
  return { allowed: true, code: 'allowed', access };
}

function clampInteger(value, { fallback, min, max }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

class EntitlementResolver {
  constructor({
    client,
    activeCacheTtlMs = 15_000,
    inactiveCacheTtlMs = 3_000,
    staleTextTtlMs = 5 * 60_000,
    maxEntries = 5_000,
    now = () => new Date(),
  } = {}) {
    if (!client?.getEntitlement) throw new Error('EntitlementResolver requires an EliPlatformClient.');
    this.client = client;
    this.activeCacheTtlMs = clampInteger(activeCacheTtlMs, { fallback: 15_000, min: 0, max: 60_000 });
    this.inactiveCacheTtlMs = clampInteger(inactiveCacheTtlMs, { fallback: 3_000, min: 0, max: 15_000 });
    this.staleTextTtlMs = clampInteger(staleTextTtlMs, {
      fallback: 5 * 60_000,
      min: this.activeCacheTtlMs,
      max: 30 * 60_000,
    });
    this.maxEntries = clampInteger(maxEntries, { fallback: 5_000, min: 1, max: 100_000 });
    this.now = now;
    this.cache = new Map();
    this.inflight = new Map();
  }

  clear(telegramUserId) {
    const normalized = normalizeTelegramUserId(telegramUserId);
    if (normalized) this.cache.delete(normalized);
  }

  clearAll() {
    this.cache.clear();
    this.inflight.clear();
  }

  cacheTtlFor(entitlement) {
    return entitlement?.active ? this.activeCacheTtlMs : this.inactiveCacheTtlMs;
  }

  setCached(userId, entitlement) {
    const fetchedAt = this.now();
    this.cache.delete(userId);
    this.cache.set(userId, { entitlement, fetchedAt });
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    return { entitlement, fetchedAt, cached: false };
  }

  getCached(telegramUserId) {
    const normalized = normalizeTelegramUserId(telegramUserId);
    if (!normalized) return null;
    const cached = this.cache.get(normalized);
    if (!cached) return null;
    this.cache.delete(normalized);
    this.cache.set(normalized, cached);
    return {
      entitlement: cached.entitlement,
      fetchedAt: new Date(cached.fetchedAt.getTime()),
      ageMs: Math.max(0, this.now().getTime() - cached.fetchedAt.getTime()),
    };
  }

  async fetchRemote(telegramUserId, { force = false } = {}) {
    const userId = normalizeTelegramUserId(telegramUserId);
    if (!userId) throw new Error('Invalid Telegram user ID.');

    const cached = this.getCached(userId);
    const ttl = this.cacheTtlFor(cached?.entitlement);
    if (!force && cached && cached.ageMs <= ttl) {
      return { entitlement: cached.entitlement, fetchedAt: cached.fetchedAt, cached: true };
    }

    if (this.inflight.has(userId)) return this.inflight.get(userId);

    const promise = Promise.resolve(this.client.getEntitlement(userId))
      .then((entitlement) => this.setCached(userId, entitlement));
    this.inflight.set(userId, promise);
    try {
      return await promise;
    } finally {
      if (this.inflight.get(userId) === promise) this.inflight.delete(userId);
    }
  }

  async resolve(telegramUserId, localAccess = {}, {
    force = false,
    requestedMode = null,
  } = {}) {
    const userId = normalizeTelegramUserId(telegramUserId);
    if (!userId) {
      return {
        ...toEffectiveLocalAccess({ active: false }),
        source: 'invalid_user',
        reason: 'invalid_telegram_user',
      };
    }

    try {
      const result = await this.fetchRemote(userId, { force });
      if (result.entitlement?.exists && result.entitlement.planId) {
        return toEffectivePaidAccess(result.entitlement);
      }
      return toEffectiveLocalAccess(localAccess, this.now());
    } catch (error) {
      const cached = this.getCached(userId);
      const mode = normalizeMode(requestedMode);
      if (
        cached?.entitlement?.exists
        && cached.entitlement.active
        && mode === 'text'
        && cached.ageMs <= this.staleTextTtlMs
      ) {
        return {
          ...toEffectivePaidAccess(cached.entitlement, {
            source: 'stale_paid_text',
            backendVerified: false,
          }),
          modes: ['text'],
          chatModes: ['text'],
          avatarMinutesPerMonth: 0,
          reason: 'backend_temporarily_unavailable',
          errorCode: error?.code || 'platform_unavailable',
        };
      }

      const local = toEffectiveLocalAccess(localAccess, this.now());
      if (local.active && (!mode || mode === 'text')) {
        return {
          ...local,
          reason: 'backend_temporarily_unavailable_local_trial_only',
          errorCode: error?.code || 'platform_unavailable',
        };
      }

      return {
        ...local,
        source: 'verification_unavailable',
        active: false,
        modes: [],
        chatModes: [],
        reason: 'paid_verification_unavailable',
        errorCode: error?.code || 'platform_unavailable',
      };
    }
  }

  async checkMode(telegramUserId, requestedMode, localAccess = {}, options = {}) {
    const access = await this.resolve(telegramUserId, localAccess, {
      ...options,
      requestedMode,
    });
    return modeDecision(access, requestedMode);
  }

  async refreshAfterPayment(telegramUserId, localAccess = {}) {
    this.clear(telegramUserId);
    return this.resolve(telegramUserId, localAccess, { force: true });
  }
}

function createEntitlementResolverFromEnv(client, env = process.env, options = {}) {
  return new EntitlementResolver({
    client,
    activeCacheTtlMs: Number(env.BOT_BILLING_ACTIVE_CACHE_TTL_MS || 15_000),
    inactiveCacheTtlMs: Number(env.BOT_BILLING_INACTIVE_CACHE_TTL_MS || 3_000),
    staleTextTtlMs: Number(env.BOT_BILLING_STALE_TEXT_TTL_MS || 5 * 60_000),
    maxEntries: Number(env.BOT_BILLING_CACHE_MAX_ENTRIES || 5_000),
    ...options,
  });
}

module.exports = {
  EntitlementResolver,
  createEntitlementResolverFromEnv,
  CHAT_MODES,
  MODE_IDS,
  normalizeModes,
  normalizeLocalAccess,
  toEffectivePaidAccess,
  toEffectiveLocalAccess,
  modeDecision,
};
