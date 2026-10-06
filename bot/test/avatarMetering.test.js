const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Isolated process-local owner identity BEFORE avatarService imports adminGuard.
// Neither the real owner ID nor any production secret is used in these tests.
process.env.OWNER_TELEGRAM_ID = '900000020';
const { meterAvatar } = require('../avatarMeteringClient');
const fixedUrl = 'https://aoaylzncorwakxcactox.supabase.co/functions/v1/avatar-metering';
const secret = 'x'.repeat(40);
const id = 'tg:900000001:12345';

test('metering client pins destination and requests server-owned 30-second hold', async () => {
  let count = 0;
  const response = await meterAvatar('reserve', '900000001', id, {}, async (url, options) => {
    count++;
    assert.equal(url, fixedUrl);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, `Bearer ${secret}`);
    assert.deepEqual(JSON.parse(options.body), {
      action: 'reserve', telegram_user_id: '900000001', request_id: id,
    });
    return { ok: true, json: async () => ({ status: 'reserved', hold_seconds: 30 }) };
  }, secret);
  assert.equal(count, 1);
  assert.equal(response.hold_seconds, 30);
});

test('metering client fails closed on unavailable, denial, malformed response, or bad IDs', async () => {
  const boom = async () => { throw new Error('offline simulation'); };
  await assert.rejects(meterAvatar('reserve', '900000001', id, {}, boom, secret));
  await assert.rejects(meterAvatar('reserve', '900000001', id, { hold_seconds: 1 }, boom, secret),
    /avatar_metering_invalid_input/);
  await assert.rejects(meterAvatar('reserve', '900000001', id, {}, async () => ({ ok: false }), secret));
  await assert.rejects(meterAvatar('reserve', '900000001', id, {}, async () => ({ ok: true, json: async () => ({}) }), secret));
  await assert.rejects(meterAvatar('reserve', '900000001', 'tg:900000002:12345', {}, boom, secret));
  await assert.rejects(meterAvatar('reserve', '900000001', id, {}, boom, 'short'));
});
test('quota exhaustion is surfaced as a specific safe error; other 403 remains generic', async () => {
  const quota = async () => ({ ok: false, status: 403, json: async () => ({ error: 'avatar_quota_exceeded' }) });
  await assert.rejects(meterAvatar('reserve', '900000001', id, {}, quota, secret),
    (error) => error.code === 'avatar_quota_exceeded');
  const unrelated = async () => ({ ok: false, status: 403, json: async () => ({ error: 'secret_problems' }) });
  await assert.rejects(meterAvatar('reserve', '900000001', id, {}, unrelated, secret),
    (error) => error.message === 'avatar_metering_denied');
});
test('allowance accepts safe integer total balances including purchased seconds above 1800', async () => {
  for (const seconds of [0, 29, 30, 1800, 5000, 2147485447, Number.MAX_SAFE_INTEGER]) {
    const status = seconds ? 'eligible' : 'exhausted';
    const response = await meterAvatar('allowance', '900000001', id, {},
      async () => ({ ok: true, json: async () => ({ status, available_seconds: seconds }) }), secret);
    assert.equal(response.available_seconds, seconds);
  }
});
test('allowance rejects unsafe, negative, fractional and nonnumeric totals', async () => {
  for (const seconds of [Number.MAX_SAFE_INTEGER + 1, -1, 30.5, '5000', null, NaN, Infinity]) {
    await assert.rejects(meterAvatar('allowance', '900000001', id, {},
      async () => ({ ok: true, json: async () => ({ status: 'eligible', available_seconds: seconds }) }), secret),
    /avatar_metering_invalid_response/);
  }
});
test('fallback wording describes total funds without promising next-period delivery', () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8');
  assert.match(source, /Общото налично време.*включено и допълнително закупено/);
  assert.match(source, /Общото оставащо време за видео аватара/);
  assert.doesNotMatch(source, /Включените минути за видео аватара|до началото на следващия период/);
});
test('Avatar-only script prompt requests 8–15 seconds, an idea and actionable step', () => {
  const index = fs.readFileSync(require.resolve('../index'), 'utf8');
  assert.match(index, /8–15 секунди/);
  assert.match(index, /20 секунди/);
  assert.match(index, /необходима|наистина необходимо/);
  assert.match(index, /една основна смислена идея/);
  assert.match(index, /една полезна следваща стъпка/);
  assert.match(index, /max_tokens: avatarMode \? 125 : voiceMode \? 300/);
});

// The orchestration tests replace ONLY module exports. No provider or Telegram
// transport is contacted, and all ledger state stays in this test process.
const fake = (name, exports) => {
  const location = require.resolve(`../${name}`);
  require.cache[location] = { id: location, filename: location, loaded: true, exports };
};
let providerCalls = 0;
let openaiCalls = 0;
let result = { url: 'https://cdn.example/avatar.mp4', durationSeconds: 12 };
let submissionError = null;
let pollingError = null;
let ledgerError = null;
let holdSubmission = null;
let allowanceSeconds = 600;
let entitlementAllowed = true;
const state = new Map();
fake('openaiClient', { audio: { speech: { create: async () => {
  openaiCalls++;
  throw new Error('Avatar must not call OpenAI speech');
} } } });
fake('heygenConfig', { isHeyGenConfigured: () => true });
fake('credits', { checkFeatureCredits: async (userId) => {
  assert.notEqual(String(userId), '900000020', 'owner never enters customer plan gate');
  return { allowed: entitlementAllowed, reason: entitlementAllowed ? undefined : 'seven_day_or_expired' };
} });
fake('heygenService', {
  capForAvatar: (s) => s,
  requestAvatarVideo: async () => {
    providerCalls++;
    if (holdSubmission) await holdSubmission;
    if (submissionError) throw submissionError;
    return 'video_12345678';
  },
  waitForVideoResult: async (_id, opts) => {
    assert.equal(opts.apiVersion, undefined, 'original V1 poll remains in use');
    if (pollingError) throw pollingError;
    return result;
  },
});
fake('avatarMeteringClient', {
  meterAvatar: async (action, user, request, extra = {}) => {
    if (ledgerError === action) throw new Error('simulated backend failure');
    let row = state.get(request);
    if (action === 'pending') {
      const pending = [...state.entries()].find(([, r]) =>
        ['submitting', 'submitted', 'uncertain'].includes(r.status));
      return pending ? { ...pending[1], request_id: pending[0] } : { status: 'none' };
    }
    if (action === 'allowance') {
      return row ? { ...row } :
        (user === '900000020' || allowanceSeconds > 0)
          ? { status: 'eligible', available_seconds: user === '900000020' ? 30 : allowanceSeconds }
          : { status: 'exhausted', available_seconds: 0 };
    }
    if (action === 'reserve') {
      assert.equal(extra.hold_seconds, undefined, 'client cannot set reserved seconds');
      if (user !== '900000020' && allowanceSeconds < 30)
        throw Object.assign(new Error('avatar_quota_exceeded'), { code: 'avatar_quota_exceeded' });
      if (!row) { row = { status: 'reserved', hold_seconds: 30 }; state.set(request, row); }
    } else if (action === 'begin' && row.status === 'reserved') row.status = 'submitting';
    else if (action === 'job' && row.status === 'submitting') { row.status = 'submitted'; row.video_id = extra.video_id; }
    else if (action === 'complete' && row.status === 'submitted') {
      row.status = 'settled'; row.duration_seconds = extra.duration_seconds; row.video_url = extra.video_url;
    } else if (action === 'failed' || action === 'uncertain') row.status = action;
    return { ...row };
  },
});
const { sendAvatarReply } = require('../avatarService');
let nextId = 20000;
function ctx(updateId = nextId++, userId = 900000001) {
  const sent = { waiting: 0, videos: 0 };
  return {
    sent, from: { id: userId }, update: { update_id: updateId },
    reply: async () => { sent.waiting++; }, sendChatAction: async () => {},
    replyWithVideo: async () => { sent.videos++; },
  };
}

test('explicit 402/429 rejection finalizes only its request and permits a new request', async () => {
  for (const status of [402, 429]) {
    const c = ctx();
    const before = providerCalls;
    submissionError = new Error(`HeyGen generate: HTTP ${status}`);
    try {
      assert.equal(await sendAvatarReply(c, 'Здравей'), false);
      assert.equal(state.get(`tg:900000001:${c.update.update_id}`).status, 'failed');
      assert.equal(await sendAvatarReply(c, 'Здравей'), false);
      assert.equal(providerCalls, before + 1);
    } finally { submissionError = null; }
    assert.equal(await sendAvatarReply(ctx(), 'Здравей'), true);
    assert.equal(providerCalls, before + 2);
  }
});

test('server-configured owner with seven-day/expired customer status bypasses plan and exhausted allowance', async () => {
  entitlementAllowed = false;
  allowanceSeconds = 0;
  const previous = providerCalls;
  const c = ctx(nextId++, 900000020);
  assert.equal(await sendAvatarReply(c, 'Здравей'), true);
  assert.equal(c.sent.videos, 1);
  assert.equal(state.get(`tg:900000020:${c.update.update_id}`).hold_seconds, 30);
  assert.equal(providerCalls, previous + 1);
  const replay = ctx(c.update.update_id, 900000020);
  assert.equal(await sendAvatarReply(replay, 'Здравей'), false);
  assert.equal(providerCalls, previous + 1, 'owner duplicate cannot resubmit');
  assert.equal(replay.sent.videos, 0);
  const ordinary = ctx();
  assert.equal(await sendAvatarReply(ordinary, 'Здравей', { isOwner: true, owner: true }), false);
  assert.equal(providerCalls, previous + 1, 'ordinary seven-day customer cannot spoof owner');
  entitlementAllowed = true;
  allowanceSeconds = 30;
});

test('exhausted and 29 remaining are distinct, both block paid generation and OpenAI speech', async () => {
  const before = providerCalls;
  allowanceSeconds = 0;
  let exhausted = 0;
  assert.equal(await sendAvatarReply(ctx(), 'Здравей', {
    onQuotaExceeded: () => { exhausted++; },
  }), false);
  assert.equal(providerCalls, before);
  allowanceSeconds = 29;
  let insufficient = 0;
  assert.equal(await sendAvatarReply(ctx(), 'Здравей', {
    onQuotaExceeded: () => { exhausted++; },
    onInsufficientTime: () => { insufficient++; },
  }), false);
  assert.equal(providerCalls, before);
  assert.equal(openaiCalls, 0);
  assert.equal(exhausted, 1);
  assert.equal(insufficient, 1);
  allowanceSeconds = 30;
});

test('completion debits before delivery, Telegram replay never generates or delivers twice', async () => {
  const before = providerCalls;
  const c = ctx();
  assert.equal(await sendAvatarReply(c, 'Здравей'), true);
  assert.equal(c.sent.videos, 1);
  assert.equal(state.get(`tg:900000001:${c.update.update_id}`).duration_seconds, 12);
  const duplicate = ctx(c.update.update_id);
  assert.equal(await sendAvatarReply(duplicate, 'Здравей'), false);
  assert.equal(duplicate.sent.videos, 0);
  assert.equal(providerCalls, before + 1);
  assert.equal(openaiCalls, 0);
});
test('large total allowance still reserves exactly 30 and settles actual duration before delivery', async () => {
  allowanceSeconds = 5000;
  const before = providerCalls;
  const c = ctx();
  try {
    assert.equal(await sendAvatarReply(c, 'Здравей'), true);
    const reservation = state.get(`tg:900000001:${c.update.update_id}`);
    assert.equal(reservation.hold_seconds, 30);
    assert.equal(reservation.duration_seconds, 12);
    assert.equal(reservation.status, 'settled');
    assert.equal(c.sent.videos, 1);
    assert.equal(providerCalls, before + 1);
    assert.equal(openaiCalls, 0);
  } finally {
    allowanceSeconds = 30;
  }
});
test('backend unavailable before reserve or after provider success denies delivery', async () => {
  ledgerError = 'allowance';
  const before = providerCalls;
  assert.equal(await sendAvatarReply(ctx(), 'Здравей'), false);
  assert.equal(providerCalls, before);
  ledgerError = 'reserve';
  const previous = providerCalls;
  assert.equal(await sendAvatarReply(ctx(), 'Здравей'), false);
  assert.equal(providerCalls, previous);
  ledgerError = 'complete';
  const c = ctx();
  assert.equal(await sendAvatarReply(c, 'Здравей'), false);
  assert.equal(c.sent.videos, 0);
  assert.equal(state.get(`tg:900000001:${c.update.update_id}`).status, 'submitted');
  ledgerError = null;
  const replay = ctx(c.update.update_id);
  assert.equal(await sendAvatarReply(replay, 'Здравей'), true);
  assert.equal(providerCalls, previous + 1);
});
test('unknown submission stays held and cannot submit again after restart/replay', async () => {
  submissionError = new Error('HeyGen generate: request timeout');
  const c = ctx();
  const previous = providerCalls;
  assert.equal(await sendAvatarReply(c, 'Здравей'), false);
  assert.equal(state.get(`tg:900000001:${c.update.update_id}`).status, 'uncertain');
  submissionError = null;
  let pendingNotified = false;
  assert.equal(await sendAvatarReply(ctx(c.update.update_id), 'Здравей', {
    onPending: () => { pendingNotified = true; },
  }), false);
  assert.equal(pendingNotified, true);
  assert.equal(providerCalls, previous + 1);
  // Simulate the operator reconciling the uncertain HeyGen submission.
  state.get(`tg:900000001:${c.update.update_id}`).status = 'failed';
});
test('definitive provider failure releases hold; transient polling retains job', async () => {
  submissionError = new Error('HeyGen generate: HTTP 422');
  const c = ctx();
  assert.equal(await sendAvatarReply(c, 'Здравей'), false);
  assert.equal(state.get(`tg:900000001:${c.update.update_id}`).status, 'failed');
  submissionError = null;
  pollingError = new Error('HeyGen video generation timed out.');
  const pending = ctx();
  assert.equal(await sendAvatarReply(pending, 'Здравей'), false);
  assert.equal(state.get(`tg:900000001:${pending.update.update_id}`).status, 'submitted');
  const previous = providerCalls;
  pollingError = null;
  assert.equal(await sendAvatarReply(ctx(pending.update.update_id), 'Здравей'), true);
  assert.equal(providerCalls, previous);
});
test('overlapping Telegram update cannot begin two provider jobs', async () => {
  let release;
  holdSubmission = new Promise((resolve) => { release = resolve; });
  const c = ctx();
  const previous = providerCalls;
  const first = sendAvatarReply(c, 'Здравей');
  while (providerCalls === previous) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(await sendAvatarReply(ctx(c.update.update_id), 'Здравей'), false);
  assert.equal(providerCalls, previous + 1);
  release();
  assert.equal(await first, true);
  holdSubmission = null;
});
test('submitted job is accounted after plan expiry but cannot deliver an expired-plan video', async () => {
  const request = `tg:900000001:${nextId++}`;
  state.set(request, { status: 'submitted', video_id: 'video_12345678', hold_seconds: 30 });
  entitlementAllowed = false;
  const c = ctx();
  const before = providerCalls;
  assert.equal(await sendAvatarReply(c, 'Здравей'), false);
  assert.equal(providerCalls, before);
  assert.equal(c.sent.videos, 0);
  assert.equal(state.get(request).status, 'settled');
  entitlementAllowed = true;
});
test('completed video longer than reserved time is quarantined without delivery', async () => {
  result = { url: 'https://cdn.example/avatar.mp4', durationSeconds: 31 };
  let warned = false;
  const c = ctx();
  const request = `tg:900000001:${c.update.update_id}`;
  state.set(request, { status: 'submitted', video_id: 'video_12345678', hold_seconds: 30 });
  assert.equal(await sendAvatarReply(c, 'Здравей', {
    onPending: () => { warned = true; },
  }), false);
  assert.equal(warned, true);
  assert.equal(c.sent.videos, 0);
  assert.equal(state.get(request).status, 'submitted');
  // Discard this isolated fixture so later test cases start independently.
  state.delete(request);
  result = { url: 'https://cdn.example/avatar.mp4', durationSeconds: 12 };
});
test('Telegram video failure logs delivery stage and leaves settled accounting and next request intact', async () => {
  const c = ctx();
  const original = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args);
  c.replyWithVideo = async () => {
    throw Object.assign(new Error('private-url-and-token'), { response: { error_code: 400 } });
  };
  try {
    assert.equal(await sendAvatarReply(c, 'Здравей'), false);
    assert.equal(state.get(`tg:900000001:${c.update.update_id}`).status, 'settled');
    const diagnostic = logs.find(([label]) => label === 'Avatar diagnostic')[1];
    assert.equal(diagnostic.stage, 'telegram_video');
    assert.equal(diagnostic.reason, 'telegram_send_video_failed');
    assert.equal(diagnostic.telegramStatus, 400);
    assert.equal(JSON.stringify(logs).includes('private-url-and-token'), false);
    assert.equal(await sendAvatarReply(ctx(), 'Здравей'), true);
  } finally { console.info = original; }
});

test('missing update ID, revoked entitlement, unknown duration never deliver', async () => {
  const noUpdate = ctx();
  delete noUpdate.update;
  const before = providerCalls;
  assert.equal(await sendAvatarReply(noUpdate, 'Здравей'), false);
  entitlementAllowed = false;
  assert.equal(await sendAvatarReply(ctx(), 'Здравей'), false);
  entitlementAllowed = true;
  assert.equal(providerCalls, before);
  result = { url: 'https://cdn.example/avatar.mp4', durationSeconds: undefined };
  const c = ctx();
  assert.equal(await sendAvatarReply(c, 'Здравей'), false);
  assert.equal(c.sent.videos, 0);
  assert.equal(state.get(`tg:900000001:${c.update.update_id}`).status, 'submitted');
});