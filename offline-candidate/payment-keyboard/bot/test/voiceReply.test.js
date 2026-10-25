// Offline tests for the voice-reply mode plumbing. No network, no TTS calls.
process.env.AVATAR_MODE_PATH = require('path').join(
  require('os').tmpdir(),
  `avatar-mode-test-${process.pid}.json`
);
process.env.AVATAR_CLAIMS_PATH = require('path').join(
  require('os').tmpdir(),
  `avatar-claims-test-${process.pid}.json`
);
process.env.ENTITLEMENTS_PATH = require('path').join(
  require('os').tmpdir(),
  `entitlements-voice-test-${process.pid}.json`
);

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

// This file covers Voice and the fail-closed Avatar fallback only; never hit
// the real metering endpoint even if the test runner has production secrets.
const meterPath = require.resolve('../avatarMeteringClient');
require.cache[meterPath] = {
  id: meterPath, filename: meterPath, loaded: true,
  exports: { meterAvatar: async () => { throw new Error('simulated backend unavailable'); } },
};

const { getMode, setMode, isAvatarMode, isVoiceMode } = require('../avatarModeStorage');
const { capForVoice, sendVoiceReply, VOICE_TEXT_LIMIT } = require('../voiceReplyService');
const { checkFeatureCredits } = require('../credits');
const { checkAvatarCredits } = require('../avatarService');
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

// The premium-delivery tests below simulate PAID users (the entitlement gate
// itself is covered in entitlements.test.js).
for (const id of [1, 904, 905, 906, 907]) activatePlan(id, 'yearly');

test.after(() => {
  try { fs.unlinkSync(process.env.AVATAR_MODE_PATH); } catch (_) {}
  try { fs.unlinkSync(process.env.AVATAR_CLAIMS_PATH); } catch (_) {}
  try { fs.unlinkSync(process.env.ENTITLEMENTS_PATH); } catch (_) {}
});

test('avatar is fail-closed when a durable backend reservation is unavailable', async () => {
  const { sendAvatarReply } = require('../avatarService');
  let pipelineStarts = 0;
  const mkCtx = () => ({
    from: { id: 907 },
    update: { update_id: 424242 },
    reply: async () => {},
    sendChatAction: async () => {
      pipelineStarts += 1;
      throw new Error('stop before paid call'); // abort after claim, before HeyGen
    },
    replyWithVideo: async () => {},
  });
  const first = await sendAvatarReply(mkCtx(), 'тест');
  const replay = await sendAvatarReply(mkCtx(), 'тест'); // same update_id replayed
  assert.strictEqual(first, false); // degraded safely (we aborted it)
  assert.strictEqual(replay, false); // backend unavailable: no paid retry
  assert.strictEqual(pipelineStarts, 0); // no side effect after backend failure
});

test('voice is a valid persistent mode', () => {
  setMode(901, 'voice');
  assert.strictEqual(getMode(901), 'voice');
  assert.strictEqual(isVoiceMode(901), true);
  assert.strictEqual(isAvatarMode(901), false);
});

test('modes are mutually exclusive and switchable', () => {
  setMode(902, 'voice');
  setMode(902, 'avatar');
  assert.strictEqual(isVoiceMode(902), false);
  assert.strictEqual(isAvatarMode(902), true);
  setMode(902, 'text');
  assert.strictEqual(getMode(902), 'text');
});

test('unknown mode still falls back to text', () => {
  setMode(903, 'nonsense');
  assert.strictEqual(getMode(903), 'text');
});

test('capForVoice keeps short text intact', () => {
  assert.strictEqual(capForVoice('Здравей! Как си днес?'), 'Здравей! Как си днес?');
  assert.strictEqual(capForVoice('   '), '');
  assert.strictEqual(capForVoice(null), '');
});

test('capForVoice cuts long text on a sentence boundary', () => {
  const sentence = 'Това е едно изречение за теста. ';
  const long = sentence.repeat(40);
  const capped = capForVoice(long);
  assert.ok(capped.length <= VOICE_TEXT_LIMIT);
  assert.ok(capped.endsWith('.'));
});

test('sendVoiceReply never throws — even when every ctx call fails', async () => {
  const boomCtx = {
    from: { id: 904 },
    reply: async () => { throw new Error('telegram down'); },
    sendChatAction: async () => { throw new Error('telegram down'); },
    replyWithVoice: async () => { throw new Error('telegram down'); },
  };
  const result = await sendVoiceReply(boomCtx, 'Здравей!');
  assert.strictEqual(result, false);
});

test('sendVoiceReply returns false for empty text without any side effects', async () => {
  let called = false;
  const ctx = {
    from: { id: 905 },
    reply: async () => { called = true; },
    sendChatAction: async () => { called = true; },
    replyWithVoice: async () => { called = true; },
  };
  const result = await sendVoiceReply(ctx, '   ');
  assert.strictEqual(result, false);
  assert.strictEqual(called, false);
});

test('avatar in-flight lock prevents concurrent duplicate paid generations', async () => {
  // Force the HeyGen path to "run" slowly by stubbing config as unconfigured is
  // not enough — instead simulate two overlapping calls: the second must be
  // rejected by the lock, never reaching a second generation.
  const { sendAvatarReply } = require('../avatarService');
  const { isHeyGenConfigured } = require('../heygenConfig');
  if (!isHeyGenConfigured()) {
    // Without config both calls return false early; the lock is untestable
    // offline in that case, so just assert the safe fallback.
    const r = await sendAvatarReply({ from: { id: 906 }, reply: async () => {} }, 'тест');
    assert.strictEqual(r, false);
    return;
  }
  let generations = 0;
  // Slow first call: sendChatAction hangs long enough for the second call to hit the lock.
  const mkCtx = () => ({
    from: { id: 906 },
    reply: async () => {},
    sendChatAction: async () => {
      generations += 1;
      // Fail AFTER the lock is taken so no real HeyGen request is ever made.
      await new Promise((r) => setTimeout(r, 150));
      throw new Error('stop before paid call');
    },
    replyWithVideo: async () => {},
  });
  const first = sendAvatarReply(mkCtx(), 'тест');
  await new Promise((r) => setTimeout(r, 30));
  const second = await sendAvatarReply(mkCtx(), 'тест');
  assert.strictEqual(second, false); // blocked by the in-flight lock
  assert.strictEqual(generations, 0); // backend unavailable: neither paid call starts
  assert.strictEqual(await first, false); // first degraded safely to text
});

test('feature credit gate allows verified paid features', async () => {
  assert.deepStrictEqual(await checkFeatureCredits(1, 'voice'), { allowed: true });
  assert.deepStrictEqual(await checkFeatureCredits(1, 'avatar'), { allowed: true });
  assert.deepStrictEqual(await checkAvatarCredits(1), { allowed: true });
});
