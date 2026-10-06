// Offline tests for the entitlement/plan architecture. No network calls.
process.env.ENTITLEMENTS_PATH = require('path').join(
  require('os').tmpdir(),
  `entitlements-test-${process.pid}.json`
);
process.env.AVATAR_MODE_PATH = require('path').join(
  require('os').tmpdir(),
  `avatar-mode-ent-test-${process.pid}.json`
);

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const {
  ensureUser,
  activatePlan,
  getStatus,
  isModeAllowed,
  shouldSendExpiryNotice,
  markExpiryNoticeSent,
  DAY_MS,
  TRIAL_DAYS,
} = require('../entitlements');
const { checkFeatureCredits } = require('../credits');
const { _setPlatformClientForTests } = require('../entitlementResolver');
const { applyTestState } = require('../commands/planAdmin');

_setPlatformClientForTests({
  getEntitlement: async (id) => {
    const status = getStatus(id);
    const rec = ensureUser(id);
    const entitlement =
      status.state === 'paid'
        ? {
            telegram_user_id: String(id),
             active: true,
            plan_id: status.plan,
            status: 'active',
             billing_status: 'active',
             starts_at: new Date(Date.now() - 1000).toISOString(),
            expires_at: new Date(status.planExpiresAt).toISOString(),
            modes: status.allowedModes,
          }
        : status.state === 'paid_expired'
          ? {
              telegram_user_id: String(id),
               active: false,
              plan_id: rec.plan,
              status: 'expired',
               billing_status: 'active',
               starts_at: new Date(rec.planActivatedAt).toISOString(),
              expires_at: new Date(rec.planExpiresAt).toISOString(),
               modes: [],
            }
          : null;
    return { entitlement };
  },
});

test.after(() => {
  try { fs.unlinkSync(process.env.ENTITLEMENTS_PATH); } catch (_) {}
  try { fs.unlinkSync(process.env.AVATAR_MODE_PATH); } catch (_) {}
});

test('new user starts a 5-day free trial with text only', () => {
  const now = Date.now();
  const rec = ensureUser(1001, now);
  assert.strictEqual(rec.plan, 'free');
  assert.strictEqual(rec.trialExpiresAt, now + TRIAL_DAYS * DAY_MS);
  const s = getStatus(1001, now + 1000);
  assert.strictEqual(s.state, 'trial');
  assert.deepStrictEqual(s.allowedModes, ['text']);
  assert.strictEqual(s.canChat, true);
});

test('ensureUser is idempotent — /start again never resets the trial', () => {
  const now = Date.now();
  const first = ensureUser(1002, now);
  const again = ensureUser(1002, now + 3 * DAY_MS);
  assert.strictEqual(again.trialStartedAt, first.trialStartedAt);
  assert.strictEqual(again.trialExpiresAt, first.trialExpiresAt);
});

test('trial expires after 5 days — no chat, no modes', () => {
  const now = Date.now();
  ensureUser(1003, now);
  const s = getStatus(1003, now + (TRIAL_DAYS + 1) * DAY_MS);
  assert.strictEqual(s.state, 'trial_expired');
  assert.strictEqual(s.canChat, false);
  assert.deepStrictEqual(s.allowedModes, []);
});

test('free user cannot invoke TTS or HeyGen through the credit gate', async () => {
  ensureUser(1004);
  assert.strictEqual((await checkFeatureCredits(1004, 'voice')).allowed, false);
  assert.strictEqual((await checkFeatureCredits(1004, 'avatar')).allowed, false);
  assert.strictEqual(isModeAllowed(1004, 'text'), true);
});

test('seven_day: text + voice allowed, avatar blocked', async () => {
  activatePlan(1005, 'seven_day');
  const s = getStatus(1005);
  assert.strictEqual(s.state, 'paid');
  assert.deepStrictEqual(s.allowedModes, ['text', 'voice']);
  assert.strictEqual((await checkFeatureCredits(1005, 'voice')).allowed, true);
  assert.strictEqual((await checkFeatureCredits(1005, 'avatar')).allowed, false);
});

test('seven_day expires after 7 days', () => {
  const now = Date.now();
  activatePlan(1006, 'seven_day', { activatedAt: now });
  assert.strictEqual(getStatus(1006, now + 6 * DAY_MS).state, 'paid');
  const after = getStatus(1006, now + 8 * DAY_MS);
  assert.notStrictEqual(after.state, 'paid');
  assert.strictEqual(after.allowedModes.includes('voice'), false);
});

test('monthly and yearly: text + voice + avatar', async () => {
  activatePlan(1007, 'monthly');
  activatePlan(1008, 'yearly');
  for (const id of [1007, 1008]) {
    const s = getStatus(id);
    assert.deepStrictEqual(s.allowedModes, ['text', 'voice', 'avatar']);
    assert.strictEqual((await checkFeatureCredits(id, 'avatar')).allowed, true);
  }
});

test('paid-plan expiry can NEVER grant a fresh free trial', () => {
  const now = Date.now();
  // User consumed their trial long ago, then bought a 7-day plan.
  ensureUser(1009, now - 30 * DAY_MS);
  activatePlan(1009, 'seven_day', {
    activatedAt: now - 10 * DAY_MS,
    expiresAt: now - 3 * DAY_MS,
  });
  const s = getStatus(1009, now);
  assert.strictEqual(s.state, 'paid_expired'); // distinguishable from a fresh trial
  assert.strictEqual(s.canChat, false); // original trial window is long gone
  assert.deepStrictEqual(s.allowedModes, []);
});

test('paid expiry while the original trial is still running falls back to text-only trial access', () => {
  const now = Date.now();
  ensureUser(1010, now); // trial just started
  activatePlan(1010, 'seven_day', {
    activatedAt: now,
    expiresAt: now + 1000, // expires almost immediately
  });
  const s = getStatus(1010, now + 2 * DAY_MS);
  assert.strictEqual(s.state, 'paid_expired');
  assert.strictEqual(s.canChat, true); // trial window still open
  assert.deepStrictEqual(s.allowedModes, ['text']);
});

test('expiry notice is sent exactly once, reset by a new activation', () => {
  activatePlan(1011, 'monthly');
  assert.strictEqual(shouldSendExpiryNotice(1011), true);
  markExpiryNoticeSent(1011);
  assert.strictEqual(shouldSendExpiryNotice(1011), false);
  activatePlan(1011, 'yearly'); // new activation resets the flag
  assert.strictEqual(shouldSendExpiryNotice(1011), true);
});

test('admin test states cover active and expired variants', () => {
  applyTestState(1012, 'seven_day_expired');
  const s = getStatus(1012);
  assert.strictEqual(s.state, 'paid_expired');
  applyTestState(1012, 'trial');
  assert.strictEqual(getStatus(1012).state, 'trial');
  applyTestState(1012, 'trial_expired');
  assert.strictEqual(getStatus(1012).canChat, false);
  applyTestState(1012, 'yearly');
  assert.strictEqual(getStatus(1012).state, 'paid');
});

test('allowed modes are derived server-side — stale stored mode cannot unlock premium', async () => {
  const { setMode, getMode } = require('../avatarModeStorage');
  // User had avatar mode stored while on monthly…
  activatePlan(1013, 'monthly');
  setMode(1013, 'avatar');
  // …then the plan expires. Stored mode says avatar, entitlement says no.
  activatePlan(1013, 'monthly', {
    activatedAt: Date.now() - 40 * DAY_MS,
    expiresAt: Date.now() - 5 * DAY_MS,
  });
  assert.strictEqual(getMode(1013), 'avatar'); // stale stored state…
  assert.strictEqual(isModeAllowed(1013, 'avatar'), false); // …is not trusted
  assert.strictEqual((await checkFeatureCredits(1013, 'avatar')).allowed, false);
});
