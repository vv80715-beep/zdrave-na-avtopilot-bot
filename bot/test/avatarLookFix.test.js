// Regression tests for the V1 avatar-Look stabilization pass:
//   • deterministic user-context classifier (root cause of the wrong Look),
//   • night-city default Look mapping + allowlist audit,
//   • static waiting message rules (once per real generation, never when
//     blocked, zero LLM/HeyGen calls of its own).
// Fully offline: HeyGen is mocked at the require-cache level — no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated storage BEFORE any require touches the real files.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lookfix-'));
process.env.AVATAR_LOOK_PATH = path.join(tmp, 'avatar_looks.json');
process.env.ENTITLEMENTS_PATH = path.join(tmp, 'entitlements.json');
process.env.AVATAR_CLAIMS_PATH = path.join(tmp, 'avatar_claims.json');
// Fake HeyGen config so isHeyGenConfigured() is true — never used for real
// calls because heygenService below is replaced by an offline mock.
process.env.HEYGEN_API_KEY = 'test-key';
process.env.HEYGEN_AVATAR_ID = 'test-avatar';
process.env.HEYGEN_VOICE_ID = 'test-voice';

// Mock heygenService in the require cache BEFORE avatarService loads it.
let heygenCalls = [];
let heygenShouldFail = false;
const heygenPath = require.resolve('../heygenService');
require.cache[heygenPath] = {
  id: heygenPath,
  filename: heygenPath,
  loaded: true,
  exports: {
    requestAvatarVideo: async (text, lookId) => {
      heygenCalls.push({ text, lookId });
      if (heygenShouldFail) throw new Error('HeyGen mock failure');
      return 'video_12345678';
    },
    waitForVideoResult: async () => ({ url: 'https://example.com/video.mp4', durationSeconds: 12 }),
    capForAvatar: (t) => String(t || '').trim(),
  },
};

// Backend quota/ledger simulation: no network, no actual paid generations.
const meterPath = require.resolve('../avatarMeteringClient');
const reservations = new Map();
require.cache[meterPath] = {
  id: meterPath, filename: meterPath, loaded: true,
  exports: {
    meterAvatar: async (action, _user, id, extra = {}) => {
      let row = reservations.get(id);
      if (action === 'pending') return { status: 'none' };
      if (action === 'allowance') {
        return row ? { ...row } : { status: 'eligible', available_seconds: 1800 };
      }
      if (action === 'reserve') {
        assert.equal(extra.hold_seconds, undefined);
        if (!row) { row = { status: 'reserved', hold_seconds: 30 }; reservations.set(id, row); }
      } else if (action === 'begin' && row.status === 'reserved') row.status = 'submitting';
      else if (action === 'job' && row.status === 'submitting') {
        row.status = 'submitted'; row.video_id = extra.video_id;
      } else if (action === 'complete' && row.status === 'submitted') {
        row.status = 'settled'; row.duration_seconds = extra.duration_seconds; row.video_url = extra.video_url;
      }
      else if (action === 'uncertain') row.status = 'uncertain';
      return { ...row };
    },
  },
};

const {
  LOOKS,
  CATEGORIES,
  classifyUserContext,
  chooseLookCategory,
  resolveLookId,
  isApprovedLookId,
} = require('../avatarLooks');
const { sendAvatarReply, WAITING_MESSAGE } = require('../avatarService');
const { activatePlan, getStatus } = require('../entitlements');
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

let nextUpdateId = 1000;
function fakeCtx(userId) {
  const sent = { replies: [], videos: [], actions: [] };
  return {
    sent,
    from: { id: userId },
    update: { update_id: nextUpdateId++ },
    reply: async (text) => sent.replies.push(text),
    replyWithVideo: async (v) => sent.videos.push(v),
    sendChatAction: async (a) => sent.actions.push(a),
  };
}

// ── Classifier: the real manual-test failure and equivalents ────────────────
test('angry/tense Bulgarian wording resolves to calm', () => {
  const phrases = [
    'Ели, днес съм много напрегнат и ядосан. Всичко ме дразни и имам нужда да се успокоя.',
    'ядосан съм',
    'много съм напрегната',
    'всичко ме дразни',
    'искам да се успокоя',
    'под голям стрес съм и съм изнервен',
  ];
  for (const p of phrases) {
    assert.equal(classifyUserContext(p), 'calm', p);
    assert.equal(chooseLookCategory(p, 'default'), 'calm', p);
  }
});

test('grief/sadness wording resolves to deep_support (beats calm)', () => {
  assert.equal(classifyUserContext('Много ми е тъжно и се чувствам самотна'), 'deep_support');
  assert.equal(classifyUserContext('плаках цяла нощ и не издържам'), 'deep_support');
});

test('motivation wording resolves to motivation', () => {
  assert.equal(classifyUserContext('Успях! Днес постигнах целта си!'), 'motivation');
  assert.equal(classifyUserContext('нямам мотивация да продължа'), 'motivation');
});

test('plan/structure wording resolves to coach', () => {
  assert.equal(classifyUserContext('Дай ми план и програма за седмицата'), 'coach');
});

test('substring/topic mentions do NOT hijack the Look (word boundaries + intent gate)', () => {
  // Stem inside another word must not match.
  assert.equal(classifyUserContext('Разкажи ми за планината Рила'), null);
  // Topic mention without request phrasing is not a coach signal.
  assert.equal(classifyUserContext('Днес бях на тренировка и после хапнах'), null);
  assert.equal(classifyUserContext('Имам си вечерен режим'), null);
  // Neutral medical wording must not force calm.
  assert.equal(classifyUserContext('Чета за нервната система'), null);
  // Request phrasing DOES make it coach.
  assert.equal(classifyUserContext('Дай ми план за седмицата'), 'coach');
  assert.equal(classifyUserContext('Искам програма за отслабване'), 'coach');
});

test('neutral wording gives no deterministic signal → model tag / default', () => {
  assert.equal(classifyUserContext('Какво да сготвя за вечеря?'), null);
  assert.equal(chooseLookCategory('Какво да сготвя за вечеря?', 'coach'), 'coach');
  assert.equal(chooseLookCategory('Здравей, как си?', 'default'), 'default');
  assert.equal(chooseLookCategory('Здравей', 'not_a_category'), 'default');
});

// ── Mapping audit ────────────────────────────────────────────────────────────
test('night-city Look is the default and mapping is complete, unique, allowlisted', () => {
  assert.equal(LOOKS.default, '31c06953333e4c8895ef9799e6f3c252');
  assert.equal(LOOKS.coach, 'f196cf2416784157b62d6e2cb78ef6af');
  assert.equal(LOOKS.calm, 'cb3dee54cbc44fb0ac17bb253a7a48df');
  assert.equal(LOOKS.deep_support, 'dd4e9b9b5438450685a8484eb1f0b015');
  assert.equal(LOOKS.motivation, '2b488449b95b4c42b42e1b58ea3934ee');
  assert.deepEqual(CATEGORIES, ['default', 'coach', 'calm', 'deep_support', 'motivation']);
  // No duplicated IDs across categories.
  assert.equal(new Set(Object.values(LOOKS)).size, CATEGORIES.length);
  for (const id of Object.values(LOOKS)) assert.ok(isApprovedLookId(id), id);
  // Legacy everyday Look stays allowlisted but is not any category's mapping.
  assert.ok(isApprovedLookId('6906845049d1412a8382bd4fa12f3a11'));
  assert.ok(!Object.values(LOOKS).includes('6906845049d1412a8382bd4fa12f3a11'));
});

test('arbitrary IDs are rejected by the allowlist', () => {
  assert.ok(!isApprovedLookId('deadbeefdeadbeefdeadbeefdeadbeef'));
  assert.ok(!isApprovedLookId(''));
  assert.ok(!isApprovedLookId(null));
});

test('a clear context switch changes the Look immediately (no debounce trap)', () => {
  const uid = 'switch-user';
  assert.equal(resolveLookId(uid, 'coach'), LOOKS.coach);
  // One angry message must switch instantly — this was the reported bug.
  assert.equal(resolveLookId(uid, 'calm'), LOOKS.calm);
  assert.equal(resolveLookId(uid, 'deep_support'), LOOKS.deep_support);
});

test('invalid/ambiguous categories resolve to the safe default', () => {
  assert.equal(resolveLookId('fresh-user', 'nonsense'), LOOKS.default);
  assert.equal(resolveLookId('fresh-user2', undefined), LOOKS.default);
});

// ── Waiting message ──────────────────────────────────────────────────────────
test('waiting message sent exactly once for a valid generation, with approved lookId', async () => {
  heygenCalls = [];
  heygenShouldFail = false;
  const uid = 90001;
  activatePlan(uid, 'monthly'); // avatar-capable plan
  const ctx = fakeCtx(uid);
  const ok = await sendAvatarReply(ctx, 'Здравей!', { lookId: LOOKS.calm });
  assert.equal(ok, true);
  const waits = ctx.sent.replies.filter((r) => r === WAITING_MESSAGE);
  assert.equal(waits.length, 1);
  assert.equal(ctx.sent.videos.length, 1);
  // The waiting message itself caused no extra generation.
  assert.equal(heygenCalls.length, 1);
  assert.equal(heygenCalls[0].lookId, LOOKS.calm);
});

test('no waiting message when entitlement blocks the generation', async () => {
  heygenCalls = [];
  const uid = 90002; // no plan → avatar mode not allowed
  const ctx = fakeCtx(uid);
  const ok = await sendAvatarReply(ctx, 'Здравей!', { lookId: LOOKS.calm });
  assert.equal(ok, false);
  assert.equal(ctx.sent.replies.length, 0);
  assert.equal(heygenCalls.length, 0);
});

test('duplicate update never repeats the waiting message or the generation', async () => {
  heygenCalls = [];
  const uid = 90003;
  activatePlan(uid, 'monthly');
  const ctx = fakeCtx(uid);
  await sendAvatarReply(ctx, 'Първо', { lookId: LOOKS.default });
  const ctx2 = fakeCtx(uid);
  ctx2.update.update_id = ctx.update.update_id; // replayed update
  const ok2 = await sendAvatarReply(ctx2, 'Първо', { lookId: LOOKS.default });
  assert.equal(ok2, false);
  assert.equal(ctx2.sent.replies.length, 0);
  assert.equal(heygenCalls.length, 1);
});

test('provider submission failure: no waiting message or video, caller falls back to text', async () => {
  heygenCalls = [];
  heygenShouldFail = true;
  const uid = 90004;
  activatePlan(uid, 'monthly');
  const ctx = fakeCtx(uid);
  const ok = await sendAvatarReply(ctx, 'Здравей!', { lookId: LOOKS.calm });
  assert.equal(ok, false); // caller then sends the text answer — user unblocked
  assert.equal(ctx.sent.replies.filter((r) => r === WAITING_MESSAGE).length, 0);
  assert.equal(ctx.sent.videos.length, 0);
  heygenShouldFail = false;
});

test('unapproved lookId is discarded server-side (falls to configured default)', async () => {
  heygenCalls = [];
  const uid = 90005;
  activatePlan(uid, 'monthly');
  const ctx = fakeCtx(uid);
  const ok = await sendAvatarReply(ctx, 'Здравей!', { lookId: 'evil-injected-id' });
  assert.equal(ok, true);
  assert.equal(heygenCalls[0].lookId, undefined);
});
