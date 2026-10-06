const test = require('node:test');
const assert = require('node:assert/strict');
const { runDueReminders, startReminderScheduler } = require('../reminderScheduler');
const { startDailyCoaching } = require('../scheduler');

const silentLogger = { log() {}, warn() {}, error() {} };

test('reminder sends once through Sofia DST fallback and records the Sofia stamp', async () => {
  const reminder = {
    id: 'r_1',
    title: 'Вода',
    category: 'water',
    paused: false,
    days: [0], // Sunday
    time: '03:30',
    lastSent: null,
  };
  const sent = [];
  const bot = {
    telegram: {
      async sendMessage(userId, message) {
        sent.push({ userId, message });
      },
    },
  };
  const options = {
    getAllReminderUserIdsFn: () => ['42'],
    getRemindersFn: () => [reminder],
    markSentFn: (_userId, _id, stamp) => { reminder.lastSent = stamp; },
    isOwnerIdFn: () => false,
  };

  await runDueReminders(bot, {
    ...options,
    now: new Date('2026-10-25T00:30:00.000Z'),
  });
  await runDueReminders(bot, {
    ...options,
    now: new Date('2026-10-25T01:30:00.000Z'),
  });

  assert.equal(sent.length, 1);
  assert.equal(reminder.lastSent, '2026-10-25 03:30');
});

test('concurrent reminder ticks cannot send the same reminder twice', async () => {
  const reminder = {
    id: 'r_2',
    title: 'Разходка',
    category: 'workout',
    paused: false,
    days: [1],
    time: '09:00',
    lastSent: null,
  };
  let releaseSend;
  let calls = 0;
  const bot = {
    telegram: {
      sendMessage() {
        calls += 1;
        return new Promise((resolve) => { releaseSend = resolve; });
      },
    },
  };
  const options = {
    now: new Date('2026-10-26T07:00:00.000Z'), // Monday, 09:00 in Sofia
    getAllReminderUserIdsFn: () => ['42'],
    getRemindersFn: () => [reminder],
    markSentFn: (_userId, _id, stamp) => { reminder.lastSent = stamp; },
    isOwnerIdFn: () => false,
  };

  const first = runDueReminders(bot, options);
  await Promise.resolve();
  const second = runDueReminders(bot, options);
  assert.equal(calls, 1);

  releaseSend();
  await Promise.all([first, second]);
  assert.equal(reminder.lastSent, '2026-10-26 09:00');
});

test('daily coaching starts immediately during the configured Sofia hour and never doubles its timer', async () => {
  const intervals = [];
  const cleared = [];
  let calls = 0;
  const options = {
    coachHour: 9,
    nowFn: () => new Date('2026-10-25T07:05:00.000Z'), // 09:05 after DST fallback
    runDailyCoachingFn: async () => { calls += 1; },
    setIntervalFn: (callback, ms) => {
      const timer = { callback, ms, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => { cleared.push(timer); },
    logger: silentLogger,
  };

  const scheduler = startDailyCoaching({}, options);
  await scheduler.ready;
  assert.equal(calls, 1);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 60_000);

  const duplicateStart = startDailyCoaching({}, options);
  assert.equal(duplicateStart, scheduler);
  await duplicateStart.tick();
  assert.equal(calls, 1);

  scheduler.stop();
  scheduler.stop();
  assert.deepEqual(cleared, [intervals[0]]);

  const restarted = startDailyCoaching({}, options);
  await restarted.ready;
  assert.equal(calls, 2);
  assert.equal(intervals.length, 2);
  restarted.stop();
  assert.deepEqual(cleared, [intervals[0], intervals[1]]);
});

test('reminder scheduler immediately ticks after restart and reuses its single timer', async () => {
  const intervals = [];
  const cleared = [];
  let calls = 0;
  const options = {
    nowFn: () => new Date('2026-10-26T07:00:00.000Z'),
    runDueRemindersFn: async () => { calls += 1; },
    setIntervalFn: (callback, ms) => {
      const timer = { callback, ms, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => { cleared.push(timer); },
    logger: silentLogger,
  };

  const scheduler = startReminderScheduler({}, options);
  await scheduler.ready;
  assert.equal(calls, 1);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 30_000);

  const duplicateStart = startReminderScheduler({}, options);
  assert.equal(duplicateStart, scheduler);
  await duplicateStart.tick();
  assert.equal(calls, 2);

  scheduler.stop();
  scheduler.stop();
  assert.deepEqual(cleared, [intervals[0]]);

  const restarted = startReminderScheduler({}, options);
  await restarted.ready;
  assert.equal(calls, 3);
  assert.equal(intervals.length, 2);
  restarted.stop();
  assert.deepEqual(cleared, [intervals[0], intervals[1]]);
});
