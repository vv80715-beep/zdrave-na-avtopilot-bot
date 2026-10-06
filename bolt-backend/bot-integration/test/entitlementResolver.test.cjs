'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EntitlementResolver } = require('../entitlementResolver.cjs');

function paidEntitlement(overrides = {}) {
  return {
    exists: true,
    telegramUserId: '8934490753',
    active: true,
    planId: 'monthly',
    plan: { id: 'monthly', name: '1 месец с Ели' },
    modes: ['text', 'voice', 'avatar', 'community'],
    avatarMinutesPerMonth: 30,
    startsAt: new Date('2026-08-19T09:00:00.000Z'),
    currentPeriodStart: new Date('2026-08-19T09:00:00.000Z'),
    currentPeriodEnd: new Date('2026-09-19T09:00:00.000Z'),
    expiresAt: new Date('2026-09-19T09:00:00.000Z'),
    billingStatus: 'active',
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

function noEntitlement() {
  return {
    exists: false,
    active: false,
    planId: null,
    modes: [],
    avatarMinutesPerMonth: 0,
  };
}

test('active backend entitlement overrides local trial and exposes paid modes', async () => {
  const resolver = new EntitlementResolver({
    client: { getEntitlement: async () => paidEntitlement() },
    now: () => new Date('2026-08-19T09:05:00.000Z'),
  });

  const access = await resolver.resolve('8934490753', {
    active: true,
    planId: 'free',
    state: 'trial',
    modes: ['text'],
  });

  assert.equal(access.source, 'paid_backend');
  assert.equal(access.planId, 'monthly');
  assert.equal(access.backendVerified, true);
  assert.deepEqual(access.chatModes, ['text', 'voice', 'avatar']);
});

test('expired paid entitlement blocks a second local trial', async () => {
  const resolver = new EntitlementResolver({
    client: { getEntitlement: async () => paidEntitlement({ active: false, modes: [], avatarMinutesPerMonth: 0 }) },
    now: () => new Date('2026-09-20T09:05:00.000Z'),
  });

  const access = await resolver.resolve('8934490753', {
    active: true,
    planId: 'free',
    state: 'trial',
    modes: ['text'],
  });

  assert.equal(access.paid, true);
  assert.equal(access.active, false);
  assert.equal(access.state, 'paid_expired');
  assert.deepEqual(access.modes, []);
});

test('new user with no paid entitlement keeps only the existing text trial', async () => {
  const resolver = new EntitlementResolver({
    client: { getEntitlement: async () => noEntitlement() },
    now: () => new Date('2026-08-19T09:05:00.000Z'),
  });

  const access = await resolver.resolve('8934490753', {
    active: true,
    planId: 'free',
    state: 'trial',
    modes: ['text', 'voice', 'avatar'],
    expiresAt: '2026-08-24T09:05:00.000Z',
  });

  assert.equal(access.source, 'local_trial');
  assert.equal(access.active, true);
  assert.deepEqual(access.chatModes, ['text']);
});

test('local hadPaidPlan flag blocks a second trial if backend has no current row', async () => {
  const resolver = new EntitlementResolver({
    client: { getEntitlement: async () => noEntitlement() },
    now: () => new Date('2026-08-19T09:05:00.000Z'),
  });
  const access = await resolver.resolve('8934490753', {
    active: true,
    planId: 'free',
    state: 'trial',
    modes: ['text'],
    hadPaidPlan: true,
  });
  assert.equal(access.active, false);
  assert.equal(access.reason, 'no_second_trial_after_paid');
});

test('voice and avatar fail closed when paid verification is unavailable', async () => {
  const resolver = new EntitlementResolver({
    client: { getEntitlement: async () => { throw Object.assign(new Error('down'), { code: 'platform_unavailable' }); } },
    now: () => new Date('2026-08-19T09:05:00.000Z'),
  });

  const local = { active: true, planId: 'monthly', state: 'paid', modes: ['text', 'voice', 'avatar'], hadPaidPlan: true };
  const voice = await resolver.checkMode('8934490753', 'voice', local);
  const avatar = await resolver.checkMode('8934490753', 'avatar', local);

  assert.equal(voice.allowed, false);
  assert.equal(voice.code, 'paid_verification_unavailable');
  assert.equal(avatar.allowed, false);
  assert.equal(avatar.code, 'paid_verification_unavailable');
});

test('backend outage still allows an existing valid local text-only trial', async () => {
  const resolver = new EntitlementResolver({
    client: { getEntitlement: async () => { throw Object.assign(new Error('down'), { code: 'platform_unavailable' }); } },
    now: () => new Date('2026-08-19T09:05:00.000Z'),
  });

  const decision = await resolver.checkMode('8934490753', 'text', {
    active: true,
    planId: 'free',
    state: 'trial',
    modes: ['text'],
    expiresAt: '2026-08-24T09:05:00.000Z',
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.access.source, 'local_trial');
});

test('fresh entitlement is cached and concurrent checks share one in-flight request', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const resolver = new EntitlementResolver({
    client: {
      getEntitlement: async () => {
        calls += 1;
        await pending;
        return paidEntitlement();
      },
    },
    now: () => new Date('2026-08-19T09:05:00.000Z'),
  });

  const first = resolver.resolve('8934490753');
  const second = resolver.resolve('8934490753');
  release();
  await Promise.all([first, second]);
  await resolver.resolve('8934490753');
  assert.equal(calls, 1);
});

test('stale paid cache may keep text briefly but never voice or avatar', async () => {
  let shouldFail = false;
  let current = new Date('2026-08-19T09:05:00.000Z');
  const resolver = new EntitlementResolver({
    client: {
      getEntitlement: async () => {
        if (shouldFail) throw Object.assign(new Error('down'), { code: 'platform_unavailable' });
        return paidEntitlement();
      },
    },
    activeCacheTtlMs: 1_000,
    staleTextTtlMs: 60_000,
    now: () => new Date(current.getTime()),
  });

  await resolver.resolve('8934490753');
  current = new Date(current.getTime() + 2_000);
  shouldFail = true;

  const text = await resolver.checkMode('8934490753', 'text');
  const avatar = await resolver.checkMode('8934490753', 'avatar');
  assert.equal(text.allowed, true);
  assert.equal(text.access.source, 'stale_paid_text');
  assert.equal(text.access.backendVerified, false);
  assert.equal(avatar.allowed, false);
});

test('cache is bounded and refreshAfterPayment forces a backend read', async () => {
  let calls = 0;
  const client = { getEntitlement: async () => { calls += 1; return paidEntitlement(); } };
  const resolver = new EntitlementResolver({
    client,
    maxEntries: 2,
    now: () => new Date('2026-08-19T09:05:00.000Z'),
  });
  await resolver.resolve('10000');
  await resolver.resolve('10001');
  await resolver.resolve('10002');
  assert.equal(resolver.cache.size, 2);

  await resolver.refreshAfterPayment('10002');
  assert.equal(calls, 4);
});
