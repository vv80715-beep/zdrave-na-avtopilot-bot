const test = require('node:test');
const assert = require('node:assert/strict');
const { providerReason, safeError, createAvatarTrace } = require('../avatarDiagnostics');

test('provider billing/auth/rate limits/invalid identities have separate safe reasons', () => {
  for (const [status, code, expected] of [
    [402, null, 'provider_billing'], [400, 'INSUFFICIENT_CREDIT', 'provider_billing'],
    [401, null, 'provider_auth'], [403, null, 'provider_auth'],
    [429, null, 'provider_rate_limit'], [503, null, 'provider_unavailable'],
    [422, 'INVALID_AVATAR_ID', 'invalid_avatar'], [400, 'VOICE_NOT_FOUND', 'invalid_voice'],
    [400, 'secret-value', 'provider_rejected'],
  ]) assert.equal(providerReason(status, { error: { code } }), expected);
});

test('unrecognized errors never echo messages, URLs, IDs, body or custom fields', () => {
  const error = Object.assign(new Error('HeyGen secret-token signed-url user-text'), {
    avatarReason: 'secret-token', response: { description: 'secret-token' },
  });
  assert.deepEqual(safeError(error, 'heygen_submit'), { reason: 'unknown' });
  assert.deepEqual(safeError(error, 'telegram_video'), { reason: 'telegram_send_video_failed' });
});

test('timeouts, transport failures, missing identity, and render failures are distinct', () => {
  for (const [message, reason] of [
    ['HeyGen generate: request timeout', 'timeout'],
    ['HeyGen video generation timed out.', 'timeout'],
    ['HeyGen generate: network error', 'network_error'],
    ['HeyGen did not return a video_id.', 'missing_video_id'],
    ['HeyGen video failed: generation error', 'provider_generation_failed'],
  ]) assert.equal(safeError(new Error(message), 'heygen_poll').reason, reason);
});

test('traces use random correlation, safe HTTP status and no raw body', () => {
  const logs = [];
  const original = console.info;
  console.info = (...args) => logs.push(args);
  try {
    const trace = createAvatarTrace();
    trace.stage = 'heygen_submit';
    trace.error = Object.assign(new Error('HeyGen generate: HTTP 402'), {
      response: { body: 'secret-token' },
    });
    trace.finish();
    const data = logs[0][1];
    assert.match(data.correlationId, /^[0-9a-f-]{36}$/);
    assert.equal(data.reason, 'provider_billing');
    assert.equal(data.httpStatus, 402);
    assert.equal(data.outcome, 'text_fallback');
    assert.equal(JSON.stringify(logs).includes('secret-token'), false);
    console.info = () => { throw new Error('broken logger'); };
    assert.doesNotThrow(() => trace.finish());
  } finally { console.info = original; }
});

test('real provider client attaches safe reason without changing messages, payload or polling', async () => {
  const location = require.resolve('../heygenConfig');
  const previousConfig = require.cache[location];
  require.cache[location] = { id: location, filename: location, loaded: true,
    exports: { getHeyGenConfig: () => ({ apiKey: 'mock-secret', avatarId: 'mock-avatar', voiceId: 'mock-voice' }) } };
  const { requestAvatarVideo, waitForVideoResult } = require('../heygenService');
  const originalFetch = global.fetch;
  let response, failure, calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    assert.equal(options.headers['X-Api-Key'], 'mock-secret');
    if (options.method === 'POST') {
      assert.equal(url, 'https://api.heygen.com/v2/video/generate');
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload.dimension, { width: 1280, height: 720 });
      assert.equal(payload.video_inputs[0].character.avatar_id, 'mock-avatar');
      assert.equal(payload.video_inputs[0].voice.voice_id, 'mock-voice');
    }
    if (failure) throw failure;
    return { ok: response.status === 200, status: response.status, json: async () => response.body };
  };
  try {
    for (const [status, code, reason] of [
      [402, 'INSUFFICIENT_CREDIT', 'provider_billing'],
      [422, 'INVALID_AVATAR_ID', 'invalid_avatar'],
      [422, 'INVALID_VOICE_ID', 'invalid_voice'],
    ]) {
      response = { status, body: { error: { code, message: 'mock-secret' } } };
      await assert.rejects(requestAvatarVideo('Кратък отговор.'), error => {
        assert.equal(error.message, `HeyGen generate: HTTP ${status}`);
        assert.equal(error.avatarReason, reason);
        assert.equal(JSON.stringify(error).includes('mock-secret'), false);
        return true;
      });
    }
    failure = Object.assign(new Error('mock-secret'), { name: 'TimeoutError' });
    await assert.rejects(requestAvatarVideo('Кратък отговор.'), /HeyGen generate: request timeout/);
    failure = null;
    response = { status: 200, body: { data: { video_id: 'mock-video' } } };
    assert.equal(await requestAvatarVideo('Кратък отговор.'), 'mock-video');
    response = { status: 200, body: { data: { status: 'completed', video_url: 'https://example.test/video', duration: 10.5 } } };
    assert.equal((await waitForVideoResult('mock-video')).durationSeconds, 11);
    response = { status: 200, body: { data: { status: 'failed' } } };
    await assert.rejects(waitForVideoResult('mock-video'), /HeyGen video failed: generation error/);
    assert.equal(calls, 7);
  } finally {
    global.fetch = originalFetch;
    if (previousConfig) require.cache[location] = previousConfig;
    else delete require.cache[location];
  }
});