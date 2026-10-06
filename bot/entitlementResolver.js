// Effective access resolver:
//   verified active Bolt entitlement > original local text-only trial.
// Paid modes are never granted from local JSON. Backend failures may preserve
// text access, but Voice/Avatar always fail closed.

const { EliPlatformClient, CANONICAL_PLAN_IDS } = require('./boltPlatformClient');
const { ensureUser, PLAN_RULES } = require('./entitlements');

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map();
let clientOverride = null;

function platformClient() {
  return clientOverride || new EliPlatformClient();
}

function planIdFrom(entitlement) {
  const value = entitlement?.plan_id;
  return CANONICAL_PLAN_IDS.has(value) ? value : null;
}

function expiryFrom(entitlement) {
  const raw = entitlement?.expires_at;
  if (typeof raw !== 'string' || !raw) {
    throw new Error('missing entitlement expiry');
  }
  const value = Date.parse(raw);
  if (!Number.isFinite(value)) throw new Error('invalid entitlement expiry');
  return value;
}

function startsAtFrom(entitlement) {
  const raw = entitlement?.starts_at;
  if (typeof raw !== 'string' || !raw) {
    throw new Error('missing entitlement start');
  }
  const value = Date.parse(raw);
  if (!Number.isFinite(value)) throw new Error('invalid entitlement start');
  return value;
}

function modesFrom(entitlement, planId) {
  const planModes = PLAN_RULES[planId].modes;
  const supplied = entitlement?.modes;
  if (!Array.isArray(supplied)) throw new Error('invalid entitlement modes');
  const unique = [...new Set(supplied.filter((m) => planModes.includes(m)))];
  return unique;
}

function activePaidStatus(userId, entitlement, now) {
  if (!entitlement) return null;
  // Authorization is deliberately strict: malformed/unknown objects never
  // grant paid access. Bolt must explicitly identify this Telegram user and
  // say that both the entitlement and its billing are active.
  if (
    entitlement.active !== true ||
    entitlement.status !== 'active' ||
    !['paid', 'active'].includes(entitlement.billing_status) ||
    String(entitlement.telegram_user_id ?? '') !== String(userId)
  ) {
    return null;
  }
  const plan = planIdFrom(entitlement);
  if (!plan) throw new Error('invalid entitlement plan');
  const startsAt = startsAtFrom(entitlement);
  const planExpiresAt = expiryFrom(entitlement);
  if (startsAt > now || now >= planExpiresAt) return null;
  const allowedModes = modesFrom(entitlement, plan);
  if (!allowedModes.includes('text')) throw new Error('invalid entitlement modes');
  const local = ensureUser(userId, now);
  return {
    plan,
    state: 'paid',
    allowedModes,
    canChat: true,
    planExpiresAt,
    trialExpiresAt: local.trialExpiresAt,
    backendVerified: true,
  };
}

function localFallbackStatus(userId, now, { hadPaid = false, backendVerified = false } = {}) {
  const local = ensureUser(userId, now);
  const trialActive = Boolean(local.trialExpiresAt && now < local.trialExpiresAt);
  const localHadPaid = local.plan && local.plan !== 'free';
  return {
    plan: 'free',
    state: hadPaid || localHadPaid
      ? 'paid_expired'
      : trialActive
        ? 'trial'
        : 'trial_expired',
    allowedModes: trialActive ? ['text'] : [],
    canChat: trialActive,
    planExpiresAt: null,
    trialExpiresAt: local.trialExpiresAt,
    backendVerified,
  };
}

async function resolveEntitlementStatus(userId, { forceRefresh = false, now = Date.now() } = {}) {
  const key = String(userId);
  const prior = cache.get(key);
  const priorCacheExpiresAt = prior
    ? Math.min(
      prior.cachedAt + CACHE_TTL_MS,
      prior.status.planExpiresAt || Number.POSITIVE_INFINITY
    )
    : 0;
  if (!forceRefresh && prior && now < priorCacheExpiresAt) {
    return { ...prior.status, allowedModes: [...prior.status.allowedModes] };
  }

  try {
    const response = await platformClient().getEntitlement(key);
    const paid = activePaidStatus(key, response.entitlement, now);
    const status =
      paid ||
      localFallbackStatus(key, now, {
        hadPaid: Boolean(response.entitlement),
        backendVerified: true,
      });
    cache.set(key, { cachedAt: now, status });
    return { ...status, allowedModes: [...status.allowedModes] };
  } catch (_) {
    // A previously verified paid response can keep TEXT available briefly, but
    // paid provider modes are stripped on every backend failure.
    if (
      prior?.status?.state === 'paid' &&
      prior.status.canChat &&
      now < priorCacheExpiresAt
    ) {
      return {
        ...prior.status,
        state: 'backend_unavailable',
        allowedModes: ['text'],
        canChat: true,
        backendVerified: false,
      };
    }
    const status = localFallbackStatus(key, now, {
      hadPaid: prior?.status?.state === 'paid',
      backendVerified: false,
    });
    return status;
  }
}

async function verifyPaidMode(userId, mode) {
  if (mode !== 'voice' && mode !== 'avatar') {
    return { allowed: false, reason: 'invalid_feature' };
  }
  // A normal status cache improves chat responsiveness, but it is never an
  // authorization source for paid providers. Every TTS/HeyGen attempt gets a
  // fresh authenticated Bolt result; failure strips Voice/Avatar immediately.
  const status = await resolveEntitlementStatus(userId, { forceRefresh: true });
  if (!status.backendVerified || status.state !== 'paid') {
    return { allowed: false, reason: 'backend_entitlement' };
  }
  if (!status.allowedModes.includes(mode)) {
    return { allowed: false, reason: 'plan' };
  }
  return { allowed: true, status };
}

function clearEntitlementCache(userId) {
  if (userId === undefined || userId === null) cache.clear();
  else cache.delete(String(userId));
}

function setPlatformClientForTests(client) {
  clientOverride = client || null;
  cache.clear();
}

module.exports = {
  resolveEntitlementStatus,
  verifyPaidMode,
  clearEntitlementCache,
  CACHE_TTL_MS,
  _setPlatformClientForTests: setPlatformClientForTests,
};