const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  listenForHealthServer,
  startBotRuntime,
  startBotRuntimeWithHealthServer,
} = require('../startup');

test('an occupied health port rejects startup before Telegram launch', async () => {
  const blocker = await listenForHealthServer(express(), 0);
  const port = blocker.address().port;
  let launchCalls = 0;
  let beforePollingCalls = 0;

  await assert.rejects(
    startBotRuntimeWithHealthServer(
      { launch() { launchCalls += 1; return Promise.resolve(); } },
      express(),
      port,
      { beforePolling: () => { beforePollingCalls += 1; } },
    ),
    { code: 'EADDRINUSE' },
  );
  assert.equal(launchCalls, 0);
  assert.equal(beforePollingCalls, 0);

  await new Promise((resolve) => blocker.close(resolve));
});

test('health port is acquired before launch and shutdown releases it idempotently', async () => {
  const calls = [];
  const bot = {
    launch(_config, onLaunch) {
      calls.push('launch');
      onLaunch();
      return new Promise(() => {});
    },
  };
  const runtime = await startBotRuntimeWithHealthServer(
    bot,
    express(),
    0,
    {
      beforePolling: () => calls.push('before-polling'),
      startSubscriptionExpiryScheduler: () => ({
        stop: () => calls.push('stop:expiry'),
      }),
      startDailyCoaching: () => ({ stop: () => calls.push('stop:daily') }),
      startReminderScheduler: () => ({ stop: () => calls.push('stop:reminder') }),
      logger: { error() {} },
    },
  );
  assert.equal(runtime.server.listening, true);
  await new Promise(setImmediate);
  assert.deepEqual(calls.slice(0, 2), ['before-polling', 'launch']);

  const serverClosed = new Promise((resolve) => runtime.server.once('close', resolve));
  runtime.stop();
  runtime.stop();
  await serverClosed;
  assert.deepEqual(calls.slice(-3), [
    'stop:reminder',
    'stop:daily',
    'stop:expiry',
  ]);
  assert.equal(runtime.server.listening, false);
});

test('starts every scheduler after Telegram launch validation without awaiting long polling', async () => {
  const calls = [];
  let resolveLaunch;
  let onLaunch;
  const bot = {
    launch(_config, callback) {
      calls.push('launch');
      onLaunch = callback;
      return new Promise((resolve) => { resolveLaunch = resolve; });
    },
  };
  const makeScheduler = (name) => () => {
    calls.push(`start:${name}`);
    return { stop: () => calls.push(`stop:${name}`) };
  };

  const runtime = startBotRuntime(bot, {
    startSubscriptionExpiryScheduler: makeScheduler('expiry'),
    startDailyCoaching: makeScheduler('daily'),
    startReminderScheduler: makeScheduler('reminder'),
    logger: { error() {} },
  });

  assert.deepEqual(calls, ['launch']);
  onLaunch();
  onLaunch();
  assert.deepEqual(calls, [
    'launch',
    'start:expiry',
    'start:daily',
    'start:reminder',
  ]);

  runtime.stop();
  runtime.stop();
  assert.deepEqual(calls.slice(-3), [
    'stop:reminder',
    'stop:daily',
    'stop:expiry',
  ]);

  resolveLaunch();
  await runtime.launchPromise;
});

test('stops already-started schedulers if startup cannot finish', () => {
  const calls = [];
  const bot = {
    launch(_config, onLaunch) {
      onLaunch();
      return Promise.resolve();
    },
  };

  assert.throws(
    () => startBotRuntime(bot, {
      startSubscriptionExpiryScheduler: () => ({ stop: () => calls.push('stop:expiry') }),
      startDailyCoaching: () => { throw new Error('daily startup failed'); },
      startReminderScheduler: () => ({ stop: () => calls.push('stop:reminder') }),
      logger: { error() {} },
    }),
    /daily startup failed/
  );
  assert.deepEqual(calls, ['stop:expiry']);
});

test('runs menu restoration only after acquiring the health port and before polling', async () => {
  const calls = [];
  const bot = {
    launch(_config, callback) {
      calls.push('launch');
      callback();
      return new Promise(() => {});
    },
  };
  const runtime = await startBotRuntimeWithHealthServer(bot, express(), 0, {
    beforePolling: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      calls.push('menu-restored');
    },
    startSubscriptionExpiryScheduler: () => ({ stop() {} }),
    startDailyCoaching: () => ({ stop() {} }),
    startReminderScheduler: () => ({ stop() {} }),
    logger: { error() {} },
  });
  assert.equal(runtime.server.listening, true);
  assert.deepEqual(calls, ['menu-restored', 'launch']);
  const closed = new Promise((resolve) => runtime.server.once('close', resolve));
  runtime.stop();
  await closed;
});
