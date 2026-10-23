'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMiniAppMutationHandler } = require('../miniAppMutations');

const OWNER = '123456789';
const USER = '987654321';

function harness() {
  const calls = [];
  const profile = { firstName: 'Synthetic', age: 30, weight: 70, createdAt: 'fixture' };
  const checkins = new Map();
  const reminders = new Map();
  const mutate = createMiniAppMutationHandler({
    getUser: (id) => (calls.push(['getUser', id]), profile),
    saveUser: (id, value) => calls.push(['saveUser', id, value]),
    addWeightEntry: (...args) => calls.push(['weight', ...args]),
    setField: (...args) => (calls.push(['memory', ...args]), { [args[1]]: args[2] }),
    extractHealthEvents: (text) => text === 'I slept 7 hours'
      ? [{ category: 'sleep', amount: 7, unit: 'ч', value: '7 ч', raw: text }]
      : [],
    recordEvents: (...args) => (calls.push(['health', ...args]), [{ date: '2026-10-23' }]),
    saveCheckin: (id, answers) => (calls.push(['checkin', id, answers]), checkins.set(id, answers)),
    getTodayCheckin: (id) => checkins.get(id) || null,
    deleteCheckin: (...args) => (calls.push(['deleteCheckin', ...args]), true),
    isOwnerId: (id) => id === OWNER,
    getReminder: (id, key) => reminders.get(`${id}:${key}`) || null,
    addReminder: (id, value) => {
      const record = { id: 'r1', ...value };
      calls.push(['addReminder', id, value]);
      reminders.set(`${id}:r1`, record);
      return record;
    },
    updateReminder: (id, key, value) => {
      calls.push(['updateReminder', id, key, value]);
      const record = { ...reminders.get(`${id}:${key}`), ...value };
      reminders.set(`${id}:${key}`, record);
      return record;
    },
    deleteReminder: (id, key) => {
      calls.push(['deleteReminder', id, key]);
      return reminders.delete(`${id}:${key}`);
    },
  });
  return { mutate, calls };
}

test('profile edits use the existing field rules and preserve other bot profile data', async () => {
  const { mutate, calls } = harness();
  const result = await mutate({ userId: OWNER, action: 'profile.update', payload: { field: 'age', value: '41' } });
  assert.equal(result.record.age, 41);
  assert.equal(result.record.firstName, 'Synthetic');
  assert.equal(calls.some(([name]) => name === 'saveUser'), true);
  await assert.rejects(mutate({ userId: OWNER, action: 'profile.update', payload: { field: 'age', value: '9' } }),
    (error) => error.code === 'invalid_request');
});

test('legacy memory clear uses the bot memory setter and health entries use the existing parser/service', async () => {
  const { mutate, calls } = harness();
  await mutate({ userId: OWNER, action: 'memory.update', payload: { field: 'allergies', value: 'Изчисти' } });
  assert.deepEqual(calls.find(([name]) => name === 'memory').slice(1), [OWNER, 'allergies', null]);
  const result = await mutate({ userId: OWNER, action: 'health.append', payload: { text: 'I slept 7 hours' } });
  assert.deepEqual(result.records, [{ date: '2026-10-23' }]);
  assert.equal(calls.find(([name]) => name === 'health')[1], OWNER);
  await assert.rejects(mutate({ userId: OWNER, action: 'health.append', payload: { text: 'unknown' } }),
    (error) => error.code === 'health_event_not_recognized');
});

test('check-ins validate bot fields and delete only through the user-scoped store call', async () => {
  const { mutate, calls } = harness();
  const answers = { water: true, trained: false, nutrition: true, sleep: 7.5, mood: 6, energy: 8 };
  await mutate({ userId: OWNER, action: 'checkin.save', payload: { answers } });
  assert.deepEqual(calls.find(([name]) => name === 'checkin').slice(1), [OWNER, answers]);
  await assert.rejects(mutate({
    userId: OWNER, action: 'checkin.save',
    payload: { answers: { ...answers, mood: 11 } },
  }), (error) => error.code === 'invalid_request');
  await mutate({ userId: OWNER, action: 'checkin.delete', payload: { date: '2026-10-23' } });
  assert.deepEqual(calls.find(([name]) => name === 'deleteCheckin').slice(1), [OWNER, '2026-10-23']);
});

test('reminders reuse canonical parsing and preserve the owner exclusion', async () => {
  const { mutate, calls } = harness();
  const created = await mutate({
    userId: USER, action: 'reminder.create',
    payload: { title: 'Water', time: '9:05', days: 'пн, сряда, петък', category: 'water' },
  });
  assert.equal(created.record.time, '09:05');
  assert.deepEqual(created.record.days, [1, 3, 5]);
  const updated = await mutate({
    userId: USER, action: 'reminder.update',
    payload: { id: created.record.id, patch: { title: 'More water' } },
  });
  assert.equal(updated.record.title, 'More water');
  const paused = await mutate({
    userId: USER, action: 'reminder.update',
    payload: { id: created.record.id, patch: { paused: true } },
  });
  assert.equal(paused.record.paused, true);
  await assert.rejects(mutate({
    userId: USER, action: 'reminder.update',
    payload: { id: created.record.id, patch: { paused: 'true' } },
  }), (error) => error.code === 'invalid_request');
  await mutate({ userId: USER, action: 'reminder.delete', payload: { id: created.record.id } });
  assert.equal(calls.some(([name]) => name === 'deleteReminder'), true);
  await assert.rejects(mutate({
    userId: OWNER, action: 'reminder.create',
    payload: { title: 'Water', time: '09:00', days: 'пн', category: 'water' },
  }), (error) => error.code === 'owner_only');
  assert.equal(calls.some(([name]) => name === 'addReminder'), true);
});
