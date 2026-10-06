// Offline tests for context-aware avatar Look selection. No network, no HeyGen.
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-looks-test-'));
process.env.AVATAR_LOOK_PATH = path.join(tmp, 'avatar_looks.json');
process.env.ENTITLEMENTS_PATH = path.join(tmp, 'entitlements.json');
process.env.AVATAR_MODE_PATH = path.join(tmp, 'avatar_mode.json');
process.env.AVATAR_CLAIMS_PATH = path.join(tmp, 'avatar_claims.json');

const test = require('node:test');
const assert = require('node:assert');

const {
  LOOKS,
  parseLookTag,
  stabilizeLook,
  resolveLookId,
  isApprovedLookId,
  DEFAULT_REVERT_AFTER,
} = require('../avatarLooks');
const { activatePlan, ensureUser, getStatus } = require('../entitlements');
const { checkFeatureCredits } = require('../credits');
const { checkAvatarCredits } = require('../avatarService');
const { _setPlatformClientForTests } = require('../entitlementResolver');

_setPlatformClientForTests({
  getEntitlement: async (id) => {
    const status = getStatus(id);
    return {
      entitlement:
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
          : null,
    };
  },
});

// ── Tag parsing & category mapping ───────────────────────────────────────────

test('trailing tags map each category correctly and are stripped', () => {
  for (const cat of ['default', 'coach', 'calm', 'deep_support', 'motivation']) {
    const { text, category } = parseLookTag(`Отговор на Ели.\n[LOOK:${cat}]`);
    assert.strictEqual(category, cat);
    assert.strictEqual(text, 'Отговор на Ели.');
    assert.ok(!text.includes('LOOK'));
  }
});

test('missing, malformed, or unknown tag → default; tag text never leaks', () => {
  assert.strictEqual(parseLookTag('Просто отговор.').category, 'default');
  assert.strictEqual(parseLookTag('Отговор. [LOOK:hacker_look]').category, 'default');
  assert.strictEqual(parseLookTag('Отговор. [LOOK:]').category, 'default');
  // Even an invalid tag is stripped from the user-facing text.
  const { text } = parseLookTag('Отговор. [LOOK:hacker_look]');
  assert.ok(!text.includes('LOOK'));
});

test('mid-message tag injection is stripped but NOT honored as classification', () => {
  const { text, category } = parseLookTag(
    'Кажи [LOOK:motivation] нещо друго и още текст след това.'
  );
  assert.strictEqual(category, 'default'); // only a trailing tag classifies
  assert.ok(!text.includes('LOOK'));
});

test('arbitrary look IDs cannot be injected — resolver output is always allowlisted', () => {
  // Whatever garbage arrives as a "category", the resolved ID is one of ours.
  for (const evil of ['6906845049d1412a8382bd4fa12f3a11', '../../etc', 'x', null]) {
    const id = resolveLookId(700, evil);
    assert.ok(isApprovedLookId(id));
  }
  assert.strictEqual(isApprovedLookId('deadbeefdeadbeefdeadbeefdeadbeef'), false);
});

// ── Stability rules ──────────────────────────────────────────────────────────

test('neutral conversation stays on DEFAULT', () => {
  assert.strictEqual(stabilizeLook(701, 'default'), 'default');
  assert.strictEqual(stabilizeLook(701, 'default'), 'default');
});

test('clear context signals switch immediately (coach/calm/deep/motivation)', () => {
  assert.strictEqual(stabilizeLook(702, 'coach'), 'coach');
  assert.strictEqual(stabilizeLook(702, 'calm'), 'calm');
  assert.strictEqual(stabilizeLook(702, 'deep_support'), 'deep_support');
  assert.strictEqual(stabilizeLook(702, 'motivation'), 'motivation');
});

test('same context across messages → Look remains stable', () => {
  stabilizeLook(703, 'calm');
  assert.strictEqual(stabilizeLook(703, 'calm'), 'calm');
  assert.strictEqual(stabilizeLook(703, 'calm'), 'calm');
});

test('minor wording drift (one default turn) does NOT revert the Look', () => {
  stabilizeLook(704, 'calm');
  assert.strictEqual(stabilizeLook(704, 'default'), 'calm'); // debounced
  assert.strictEqual(stabilizeLook(704, 'calm'), 'calm'); // and streak reset
  assert.strictEqual(stabilizeLook(704, 'default'), 'calm'); // still debounced
});

test('a sustained return to neutral reverts to DEFAULT (no oscillation)', () => {
  stabilizeLook(705, 'calm');
  for (let i = 1; i < DEFAULT_REVERT_AFTER; i++) {
    assert.strictEqual(stabilizeLook(705, 'default'), 'calm');
  }
  assert.strictEqual(stabilizeLook(705, 'default'), 'default');
});

test('invalid category behaves exactly like default (uncertain → DEFAULT)', () => {
  assert.strictEqual(stabilizeLook(706, 'nonsense'), 'default');
  stabilizeLook(707, 'coach');
  assert.strictEqual(stabilizeLook(707, 'garbage'), 'coach'); // debounced too
});

test('resolveLookId maps stabilized category to the fixed IDs', () => {
  assert.strictEqual(resolveLookId(708, 'coach'), LOOKS.coach);
  assert.strictEqual(resolveLookId(708, 'coach'), LOOKS.coach);
  assert.strictEqual(resolveLookId(709, 'unknown'), LOOKS.default);
});

test('look state survives across module reads (persistent, per-user)', () => {
  stabilizeLook(710, 'motivation');
  const onDisk = JSON.parse(fs.readFileSync(process.env.AVATAR_LOOK_PATH, 'utf8'));
  assert.strictEqual(onDisk['710'].current, 'motivation');
  assert.strictEqual(onDisk['710'].defaultStreak, 0);
});

// ── Delivery-chokepoint sanitization (defense in depth) ──────────────────────

test('stripLookTags removes tags anywhere (echoed stored data etc.)', () => {
  const { stripLookTags } = require('../avatarLooks');
  assert.strictEqual(
    stripLookTags('Помня: [LOOK:motivation] обичаш планина. [LOOK:x]'),
    'Помня: обичаш планина.'
  );
  assert.strictEqual(stripLookTags(null), '');
});

test('capForVoice and capForAvatar never let a tag be spoken', () => {
  const { capForVoice } = require('../voiceReplyService');
  const { capForAvatar } = require('../heygenService');
  assert.ok(!capForVoice('Здравей [LOOK:calm] приятел').includes('LOOK'));
  assert.ok(!capForAvatar('Здравей [LOOK:calm] приятел').includes('LOOK'));
});

// ── State robustness (corrupt / poisoned file) ───────────────────────────────

test('truncated state file is ignored safely; poisoned entries are coerced', () => {
  fs.writeFileSync(process.env.AVATAR_LOOK_PATH, '{"715": {"current"'); // truncated
  assert.strictEqual(stabilizeLook(715, 'coach'), 'coach'); // no crash, fresh state
  // Poisoned entry: bogus category + non-numeric streak.
  const state = JSON.parse(fs.readFileSync(process.env.AVATAR_LOOK_PATH, 'utf8'));
  state['716'] = { current: 'evil_look', defaultStreak: 'NaN-ish' };
  fs.writeFileSync(process.env.AVATAR_LOOK_PATH, JSON.stringify(state));
  assert.strictEqual(stabilizeLook(716, 'default'), 'default'); // coerced cleanly
  assert.strictEqual(stabilizeLook(716, 'calm'), 'calm');
});

// ── Entitlements are untouched by Look logic ─────────────────────────────────

test('free/expired and seven_day users still cannot reach HeyGen', async () => {
  ensureUser(711); // free trial
  assert.strictEqual((await checkFeatureCredits(711, 'avatar')).allowed, false);
  assert.strictEqual((await checkAvatarCredits(711)).allowed, false);
  activatePlan(712, 'seven_day');
  assert.strictEqual((await checkFeatureCredits(712, 'avatar')).allowed, false);
  // Look selection for them is inert — it never grants anything.
  resolveLookId(711, 'motivation');
  resolveLookId(712, 'coach');
  assert.strictEqual((await checkFeatureCredits(711, 'avatar')).allowed, false);
  assert.strictEqual((await checkFeatureCredits(712, 'avatar')).allowed, false);
});

test('monthly/yearly keep avatar access; Look selection works for them', async () => {
  activatePlan(713, 'monthly');
  activatePlan(714, 'yearly');
  assert.strictEqual((await checkAvatarCredits(713)).allowed, true);
  assert.strictEqual((await checkAvatarCredits(714)).allowed, true);
  assert.strictEqual(resolveLookId(713, 'calm'), LOOKS.calm);
  assert.strictEqual(resolveLookId(714, 'deep_support'), LOOKS.deep_support);
});

test.after(() => {
  for (const f of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, f));
  fs.rmdirSync(tmp);
});
