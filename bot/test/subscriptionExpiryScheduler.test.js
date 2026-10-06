const { test } = require('node:test');
const assert = require('node:assert/strict');

test('production starts expiry wake-ups before awaiting long polling', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const startup = source.slice(source.indexOf('async function start()'));
  const scheduler = startup.indexOf('const expiryScheduler = startSubscriptionExpiryScheduler();');
  assert.ok(scheduler >= 0 && scheduler < startup.indexOf('await bot.launch()'));
  assert.ok(startup.includes('expiryScheduler.stop();'));
});
const { startSubscriptionExpiryScheduler } = require('../subscriptionExpiryScheduler');

const ENDPOINT =
  'https://aoaylzncorwakxcactox.supabase.co/functions/v1/subscription-expiry';
const SECRET = 's'.repeat(40);

function harness(fetchFn, env = { BOT_PURCHASE_API_SECRET: SECRET }) {
  const intervals = [];
  const timeouts = [];
  const logs = [];
  const scheduler = startSubscriptionExpiryScheduler({
    fetchFn,
    env,
    logger: { warn: (message) => logs.push(message) },
    setIntervalFn: (callback, ms) => {
      const timer = { callback, ms, cleared: false, unref() { this.unrefed = true; } };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => { timer.cleared = true; },
    setTimeoutFn: (callback, ms) => {
      const timer = { callback, ms, cleared: false, unref() { this.unrefed = true; } };
      timeouts.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => { timer.cleared = true; },
  });
  return { scheduler, intervals, timeouts, logs };
}

test('wakes once per minute, never immediately, with a pinned POST and no redirects', async () => {
  const calls = [];
  const h = harness(async (url, options) => {
    calls.push({ url, options });
    return { ok: true };
  }, {
    BOT_PURCHASE_API_SECRET: SECRET,
    ELI_PLATFORM_BASE_URL: 'https://attacker.example/secret-in-url',
    SUPABASE_URL: 'https://attacker.example',
  });
  assert.equal(calls.length, 0);
  assert.equal(h.intervals[0].ms, 60000);
  assert.equal(h.intervals[0].unrefed, true);
  await h.intervals[0].callback();
  await h.intervals[0].callback();
  assert.equal(calls.length, 2);
  for (const { url, options } of calls) {
    assert.equal(url, ENDPOINT);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(options.body, undefined);
    assert.equal(options.signal.aborted, false);
  }
  assert.equal(h.timeouts[0].ms, 50000);
  assert.equal(h.timeouts[0].unrefed, true);
  assert.equal(h.timeouts[0].cleared, true);
  h.scheduler.stop();
});

test('a slow request cannot overlap the next tick, and a failed request retries next tick', async () => {
  let rejectFirst;
  let count = 0;
  const h = harness(() => {
    count += 1;
    if (count === 1) return new Promise((_resolve, reject) => { rejectFirst = reject; });
    return Promise.resolve({ ok: true });
  });
  const pending = h.intervals[0].callback();
  await h.intervals[0].callback();
  assert.equal(count, 1);
  rejectFirst(new Error(`secret=${SECRET} https://attacker.example/token`));
  await pending;
  assert.deepEqual(h.logs, ['Subscription expiry worker request failed: network_error.']);
  await h.intervals[0].callback();
  assert.equal(count, 2);
  h.scheduler.stop();
});

test('timeout aborts the request and a following tick can retry', async () => {
  let count = 0;
  const h = harness((_url, options) => {
    count += 1;
    if (count > 1) return Promise.resolve({ ok: true });
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error(`secret=${SECRET}`)));
    });
  });
  const pending = h.intervals[0].callback();
  h.timeouts[0].callback();
  await pending;
  assert.deepEqual(h.logs, ['Subscription expiry worker request failed: timeout.']);
  await h.intervals[0].callback();
  assert.equal(count, 2);
  h.scheduler.stop();
});

test('stop clears interval, aborts in-flight work, and blocks queued ticks', async () => {
  let count = 0;
  const h = harness((_url, options) => {
    count += 1;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('sensitive body')));
    });
  });
  const pending = h.intervals[0].callback();
  h.scheduler.stop();
  h.scheduler.stop();
  await pending;
  await h.intervals[0].callback();
  assert.equal(h.intervals[0].cleared, true);
  assert.equal(count, 1);
  assert.deepEqual(h.logs, []);
});

test('missing or short secret fails closed and logs once without revealing values', async () => {
  for (const secret of [undefined, 'short']) {
    let calls = 0;
    const h = harness(() => { calls += 1; }, {
      BOT_PURCHASE_API_SECRET: secret,
    });
    assert.equal(h.intervals.length, 0);
    h.scheduler.stop();
    assert.equal(calls, 0);
    assert.deepEqual(h.logs, ['Subscription expiry scheduler disabled: invalid secret.']);
  }
});

test('HTTP failures log only a category, not untrusted response data', async () => {
  const h = harness(async () => ({
    ok: false,
    status: 403,
    body: `secret=${SECRET}`,
    url: 'https://attacker.example/private',
  }));
  await h.intervals[0].callback();
  assert.deepEqual(h.logs, ['Subscription expiry worker request failed: http_error.']);
  h.scheduler.stop();
});