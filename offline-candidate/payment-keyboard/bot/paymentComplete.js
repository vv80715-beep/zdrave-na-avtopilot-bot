const { EliPlatformClient } = require('./boltPlatformClient');

const PLAN_LABELS = {
  seven_day: '7 дни',
  monthly: 'Месечен',
  yearly: 'Годишен',
};
const MODE_LABELS = {
  text: 'Текст',
  voice: 'Глас',
  avatar: 'Аватар',
  community: 'Общност',
};
const PLAN_MODES = {
  seven_day: ['text', 'voice', 'community'],
  monthly: ['text', 'voice', 'avatar', 'community'],
  yearly: ['text', 'voice', 'avatar', 'community'],
};

// This receipt check deliberately never reads owner privileges, local plans,
// or the effective-access cache. Subscription billing can be "active".
async function resolvePaymentCompleteStatus(userId, {
  client,
  now = Date.now(),
} = {}) {
  const unconfirmed = { active: false, state: 'payment_unconfirmed', backendVerified: false };
  try {
    const { entitlement } = await (client || new EliPlatformClient()).getEntitlement(String(userId));
    if (
      !entitlement ||
      entitlement.active !== true ||
      entitlement.status !== 'active' ||
      !['paid', 'active'].includes(entitlement.billing_status) ||
      !Object.hasOwn(PLAN_LABELS, entitlement.plan_id) ||
      String(entitlement.telegram_user_id) !== String(userId) ||
      !(Date.parse(entitlement.starts_at) <= now) ||
      !(Date.parse(entitlement.expires_at) > now) ||
      !Array.isArray(entitlement.modes) ||
      !entitlement.modes.includes('text')
    ) {
      return { ...unconfirmed, backendVerified: true };
    }
    return {
      active: true,
      state: 'paid',
      backendVerified: true,
      plan: entitlement.plan_id,
      allowedModes: entitlement.modes.filter((mode) =>
        PLAN_MODES[entitlement.plan_id].includes(mode)
      ),
    };
  } catch (_) {
    return unconfirmed;
  }
}

function communityUrl(env = process.env) {
  const explicit = String(env.ELI_COMMUNITY_URL || '').trim();
  const origin = String(env.ELI_PURCHASE_URL_ORIGIN || '').trim();
  try {
    const url = new URL(explicit || origin);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return explicit ? url.href : new URL('/community.html', url.origin).href;
  } catch (_) {
    return null;
  }
}

module.exports = { resolvePaymentCompleteStatus, communityUrl, PLAN_LABELS, MODE_LABELS };