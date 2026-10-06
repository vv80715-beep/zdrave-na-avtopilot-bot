const test = require('node:test');
const assert = require('node:assert/strict');
const { startBotRuntime } = require('../startup');

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
