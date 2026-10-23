'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMiniAppCoachTurnHandler } = require('../miniAppCoachTurn');

function makeHandler(overrides = {}) {
  const calls = [];
  let now = 10_000;
  const noop = async (...args) => (calls.push(args), 'Synthetic coaching text');
  const handler = createMiniAppCoachTurnHandler({
    resolveReadOnlyAccessStatus: async () => ({ canChat: true }),
    hasTextAIProvider: () => true,
    getTextAIClient: (id) => ({ id }),
    isOwnerId: (id) => id === '123456789',
    generateCoach: noop,
    generateMotivate: noop,
    generateNextStep: noop,
    generateWeeklyReview: noop,
    hasWeeklyData: () => true,
    now: () => now,
    ...overrides,
  });
  return { handler, calls, setNow: (value) => { now = value; } };
}

test('coaching uses the authenticated user, read-only access check, and does not persist owner motivation', async () => {
  const { handler, calls } = makeHandler();
  const result = await handler({ userId: '123456789', action: 'coach' });
  assert.deepEqual(result, { kind: 'coaching', text: 'Synthetic coaching text' });
  assert.deepEqual(calls[0], [{ id: '123456789' }, '123456789', { persist: false }]);
});

test('expired access is denied before provider use', async () => {
  let providerCalls = 0;
  const { handler } = makeHandler({
    resolveReadOnlyAccessStatus: async () => ({ canChat: false }),
    hasTextAIProvider: () => { providerCalls++; return true; },
  });
  assert.equal((await handler({ userId: '987654321', action: 'motivate' })).kind, 'access_denied');
  assert.equal(providerCalls, 0);
});

test('weekly review with no check-ins does not make an AI request', async () => {
  let providerCalls = 0;
  const { handler } = makeHandler({
    hasWeeklyData: () => false,
    hasTextAIProvider: () => { providerCalls++; return true; },
  });
  assert.deepEqual(await handler({ userId: '987654321', action: 'weeklyreview' }), { kind: 'no_data', text: '' });
  assert.equal(providerCalls, 0);
});

test('repeated coaching requests are rate limited and invalid actions are rejected', async () => {
  const { handler, setNow } = makeHandler();
  await handler({ userId: '987654321', action: 'nextstep' });
  setNow(11_000);
  await assert.rejects(handler({ userId: '987654321', action: 'motivate' }), (error) => error.code === 'coach_rate_limited');
  await assert.rejects(handler({ userId: '987654321', action: 'plan' }), (error) => error.code === 'invalid_request');
});
