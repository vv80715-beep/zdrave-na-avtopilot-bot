// Tests for the HeyGen avatar integration modules.
// No network calls are made — only pure helpers and storage are tested.
// Runs with the built-in Node test runner: `npm test` (node --test).

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

// Isolate the mode store and blank out HeyGen env BEFORE loading modules.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-heygen-test-'));
process.env.AVATAR_MODE_PATH = path.join(tmp, 'avatar_mode.json');
process.env.ENTITLEMENTS_PATH = path.join(tmp, 'entitlements.json');
process.env.AVATAR_CLAIMS_PATH = path.join(tmp, 'avatar_claims.json');

const { capForAvatar, requestAvatarVideo, waitForVideoResult, MAX_AVATAR_TEXT_CHARS } = require('../heygenService');
const { getMode, setMode, isAvatarMode } = require('../avatarModeStorage');
const { checkAvatarCredits, sendAvatarReply } = require('../avatarService');

// ── capForAvatar (cost control) ──────────────────────────────────────────────

test('short Bulgarian text passes through unchanged', () => {
  const t = 'Браво! Продължавай да пиеш вода редовно.';
  assert.strictEqual(capForAvatar(t), t);
});

test('long text is capped under the limit', () => {
  const long = 'Едно дълго изречение за здравето и съня. '.repeat(30);
  const capped = capForAvatar(long);
  assert.ok(capped.length <= MAX_AVATAR_TEXT_CHARS + 1);
});

test('capping prefers a sentence boundary', () => {
  const long =
    'Първо изречение за водата. Второ изречение за съня. ' + 'х'.repeat(400);
  const capped = capForAvatar(long);
  assert.ok(capped.endsWith('.') || capped.endsWith('…'));
});

test('empty input stays empty', () => {
  assert.strictEqual(capForAvatar(''), '');
  assert.strictEqual(capForAvatar(null), '');
});

// ── Mode storage ─────────────────────────────────────────────────────────────

test('default mode is text', () => {
  assert.strictEqual(getMode(111), 'text');
  assert.strictEqual(isAvatarMode(111), false);
});

test('switching to avatar mode persists per user', () => {
  setMode(222, 'avatar');
  assert.strictEqual(isAvatarMode(222), true);
  assert.strictEqual(isAvatarMode(333), false); // other users unaffected
});

test('switching back to text mode works', () => {
  setMode(222, 'avatar');
  setMode(222, 'text');
  assert.strictEqual(isAvatarMode(222), false);
});

test('unknown mode values fall back to text', () => {
  setMode(444, 'nonsense');
  assert.strictEqual(getMode(444), 'text');
});

// ── Credit gate (entitlement-backed) ─────────────────────────────────────────

test('credit gate allows avatar only for plans that include it', async () => {
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
  // Default (free trial) user: avatar blocked server-side.
  const blocked = await checkAvatarCredits(555);
  assert.strictEqual(blocked.allowed, false);
  // Monthly plan unlocks it.
  activatePlan(555, 'monthly');
  assert.strictEqual((await checkAvatarCredits(555)).allowed, true);
});

// ── Fallback safety: no config → no API call, graceful false ─────────────────

test('sendAvatarReply falls back safely when HeyGen is unconfigured', async () => {
  const saveKey = process.env.HEYGEN_API_KEY;
  delete process.env.HEYGEN_API_KEY; // simulate missing config
  try {
    let replied = false;
    const ctx = {
      from: { id: 666 },
      reply: async () => {
        replied = true;
      },
      sendChatAction: async () => {},
      replyWithVideo: async () => {
        throw new Error('must never be called without config');
      },
    };
    const sent = await sendAvatarReply(ctx, 'Здравей!');
    assert.strictEqual(sent, false); // fell back, no video, no crash
    assert.strictEqual(replied, false); // silent fallback — text already sent
  } finally {
    if (saveKey !== undefined) process.env.HEYGEN_API_KEY = saveKey;
  }
});

test('original text/VOICE_ID generation and V1 status charge rounded actual duration (offline transport)', async () => {
  const originalFetch = global.fetch;
  const saved = ['HEYGEN_API_KEY', 'HEYGEN_AVATAR_ID', 'HEYGEN_VOICE_ID']
    .map((key) => [key, process.env[key]]);
  process.env.HEYGEN_API_KEY = 'offline-test-key';
  process.env.HEYGEN_AVATAR_ID = 'offline-avatar-id';
  process.env.HEYGEN_VOICE_ID = 'offline-voice-id';
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push(url);
    assert.strictEqual(options.headers['X-Api-Key'], 'offline-test-key');
    if (url === 'https://api.heygen.com/v2/video/generate') {
      assert.strictEqual(options.method, 'POST');
      const body = JSON.parse(options.body);
      assert.strictEqual(body.video_inputs[0].voice.type, 'text');
      assert.strictEqual(body.video_inputs[0].voice.input_text, 'Здравей, приятелю!');
      assert.strictEqual(body.video_inputs[0].voice.voice_id, 'offline-voice-id');
      assert.strictEqual(body.video_inputs[0].character.avatar_id, 'offline-look-id');
      assert.ok(!JSON.stringify(body).includes('audio_asset_id'));
      return { ok: true, json: async () => ({ data: { video_id: 'video_12345678' } }) };
    }
    assert.strictEqual(url, 'https://api.heygen.com/v1/video_status.get?video_id=video_12345678');
    return { ok: true, json: async () => ({ data: {
      status: 'completed', duration: 11.1, video_url: 'https://cdn.example/avatar.mp4',
    } }) };
  };
  try {
    const id = await requestAvatarVideo('Здравей, приятелю!', 'offline-look-id');
    assert.strictEqual(id, 'video_12345678');
    const result = await waitForVideoResult(id, { intervalMs: 1 });
    assert.deepStrictEqual(result, { url: 'https://cdn.example/avatar.mp4', durationSeconds: 12 });
    assert.strictEqual(seen.length, 2, 'no audio or other provider calls');
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
