// ─────────────────────────────────────────────────────────────────────────────
// Central feature gate for Eli's paid/premium reply modes.
//
// EVERY premium delivery (HeyGen avatar video, TTS voice reply) must pass
// through checkFeatureCredits() before spending anything. It enforces the
// server-side entitlement (plan → allowed modes) and then the quota hook —
// hiding buttons is NOT security; this gate is the real guard, so stale
// keyboards, crafted commands, replayed updates and mid-session expiry can
// never trigger a paid provider call.
//
// Features:
//   'avatar' — one HeyGen avatar video generation (requires avatar mode access)
//   'voice'  — one TTS voice reply               (requires voice mode access)
// ─────────────────────────────────────────────────────────────────────────────

const { checkQuota } = require('./entitlements');
const { verifyPaidMode } = require('./entitlementResolver');

async function checkFeatureCredits(userId, feature) {
  const mode = feature === 'avatar' ? 'avatar' : 'voice';
  const entitlement = await verifyPaidMode(userId, mode);
  if (!entitlement.allowed) return entitlement;
  const quota = checkQuota(userId, feature);
  if (!quota.allowed) return { allowed: false, reason: 'quota' };
  return { allowed: true };
}

module.exports = { checkFeatureCredits };
