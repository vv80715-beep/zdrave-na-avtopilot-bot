'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PLANS, isValidPlanId, getPlan } = require('../plans');
const { computePlanPeriod } = require('../entitlementWriter');
const {
  toEffectivePaidAccess,
  toEffectiveLocalAccess,
  modeDecision,
  normalizeLocalAccess,
} = require('../../bot-integration/entitlementResolver.cjs');
const { normalizeEntitlementResponse } = require('../../bot-integration/eliPlatformClient.cjs');

const NOW = new Date('2026-08-24T10:00:00.000Z');
const TELEGRAM_USER_ID = '8934490753';

// ---------------------------------------------------------------------------
// Plan catalog: prices, modes, avatar allowances
// ---------------------------------------------------------------------------

test('7-day plan: €15, 7 days, no avatar, 0 avatar minutes', () => {
  const plan = PLANS.seven_day;
  assert.equal(plan.price.amount, 15);
  assert.equal(plan.price.currency, 'EUR');
  assert.equal(plan.durationDays, 7);
  assert.ok(!plan.modes.includes('avatar'));
  assert.equal(plan.avatarMinutesPerMonth, 0);
  assert.ok(plan.modes.includes('text'));
  assert.ok(plan.modes.includes('voice'));
  assert.ok(plan.modes.includes('community'));
});

test('monthly plan: €50, 30 days, avatar, 30 avatar minutes/month', () => {
  const plan = PLANS.monthly;
  assert.equal(plan.price.amount, 50);
  assert.equal(plan.price.currency, 'EUR');
  assert.equal(plan.durationDays, 30);
  assert.ok(plan.modes.includes('avatar'));
  assert.equal(plan.avatarMinutesPerMonth, 30);
  assert.ok(plan.modes.includes('text'));
  assert.ok(plan.modes.includes('voice'));
  assert.ok(plan.modes.includes('community'));
});

test('yearly plan: €360, 365 days, avatar, 20 avatar minutes/month', () => {
  const plan = PLANS.yearly;
  assert.equal(plan.price.amount, 360);
  assert.equal(plan.price.currency, 'EUR');
  assert.equal(plan.durationDays, 365);
  assert.ok(plan.modes.includes('avatar'));
  assert.equal(plan.avatarMinutesPerMonth, 20);
  assert.ok(plan.modes.includes('text'));
  assert.ok(plan.modes.includes('voice'));
  assert.ok(plan.modes.includes('community'));
});

test('invalid/tampered plan ID is rejected', () => {
  assert.equal(isValidPlanId('free'), false);
  assert.equal(isValidPlanId('premium'), false);
  assert.equal(isValidPlanId(''), false);
  assert.equal(isValidPlanId('monthly_discounted'), false);
  assert.equal(isValidPlanId('SEVEN_DAY'), false);
  assert.equal(getPlan('hacked'), null);
});

// ---------------------------------------------------------------------------
// Plan period computation
// ---------------------------------------------------------------------------

test('7-day plan period: starts now, expires 7 days later', () => {
  const period = computePlanPeriod('seven_day', NOW);
  assert.equal(period.startsAt.toISOString(), NOW.toISOString());
  const expected = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
  assert.equal(period.expiresAt.toISOString(), expected.toISOString());
});

test('monthly plan period: starts now, expires 30 days later', () => {
  const period = computePlanPeriod('monthly', NOW);
  const expected = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
  assert.equal(period.expiresAt.toISOString(), expected.toISOString());
});

test('yearly plan period: starts now, expires 365 days later', () => {
  const period = computePlanPeriod('yearly', NOW);
  const expected = new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000);
  assert.equal(period.expiresAt.toISOString(), expected.toISOString());
});

// ---------------------------------------------------------------------------
// Entitlement resolver: paid overrides trial, expired blocks, fail-closed
// ---------------------------------------------------------------------------

function paidEntitlement(overrides = {}) {
  return {
    exists: true,
    telegramUserId: TELEGRAM_USER_ID,
    active: true,
    planId: 'monthly',
    plan: { id: 'monthly', name: '1 месец с Ели' },
    modes: ['text', 'voice', 'avatar', 'community'],
    avatarMinutesPerMonth: 30,
    startsAt: new Date('2026-08-24T09:00:00.000Z'),
    currentPeriodStart: new Date('2026-08-24T09:00:00.000Z'),
    currentPeriodEnd: new Date('2026-09-23T09:00:00.000Z'),
    expiresAt: new Date('2026-09-23T09:00:00.000Z'),
    billingStatus: 'active',
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

function noEntitlement() {
  return { exists: false, active: false, planId: null, modes: [], avatarMinutesPerMonth: 0 };
}

test('paid plan overrides local trial state', () => {
  const access = toEffectivePaidAccess(paidEntitlement());
  assert.equal(access.active, true);
  assert.equal(access.paid, true);
  assert.equal(access.backendVerified, true);
  assert.equal(access.planId, 'monthly');
  assert.deepEqual(access.chatModes, ['text', 'voice', 'avatar']);
});

test('expired paid entitlement blocks a second trial', () => {
  const expired = paidEntitlement({ active: false, modes: [], avatarMinutesPerMonth: 0 });
  const access = toEffectivePaidAccess(expired);
  assert.equal(access.active, false);
  assert.equal(access.state, 'paid_expired');
  assert.deepEqual(access.modes, []);
});

test('local access with hadPaidPlan does not get another trial', () => {
  const local = normalizeLocalAccess({ active: true, planId: 'free', state: 'trial', modes: ['text'], hadPaidPlan: true });
  const access = toEffectiveLocalAccess(local, NOW);
  assert.equal(access.active, false);
  assert.equal(access.reason, 'no_second_trial_after_paid');
});

test('voice fails closed when backend verification is unavailable', () => {
  // Simulate a scenario where the resolver returns paid access but backendVerified is false
  // (e.g. stale cache during backend outage). Voice must be blocked.
  const access = toEffectivePaidAccess(paidEntitlement(), { backendVerified: false });
  const decision = modeDecision(access, 'voice');
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'paid_verification_required');
});

test('avatar fails closed when backend verification is unavailable', () => {
  const access = toEffectivePaidAccess(paidEntitlement(), { backendVerified: false });
  const decision = modeDecision(access, 'avatar');
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'paid_verification_required');
});

// ---------------------------------------------------------------------------
// Entitlement response normalization (bot bridge)
// ---------------------------------------------------------------------------

function rawEntitlementResponse(entitlementOverrides = {}) {
  return {
    api_version: 1,
    checked_at: NOW.toISOString(),
    entitlement: {
      telegram_user_id: TELEGRAM_USER_ID,
      active: true,
      plan_id: 'monthly',
      plan: { id: 'monthly', name: '1 месец с Ели' },
      status: 'active',
      billing_status: 'active',
      modes: ['text', 'voice', 'avatar', 'community'],
      avatar_minutes_per_month: 30,
      starts_at: '2026-08-24T09:00:00.000Z',
      current_period_start: '2026-08-24T09:00:00.000Z',
      current_period_end: '2026-09-23T09:00:00.000Z',
      expires_at: '2026-09-23T09:00:00.000Z',
      cancel_at_period_end: false,
      ...entitlementOverrides,
    },
  };
}

test('7-day entitlement response: no avatar modes, 0 avatar minutes', () => {
  const payload = rawEntitlementResponse({
    telegram_user_id: TELEGRAM_USER_ID,
    active: true,
    plan_id: 'seven_day',
    plan: { id: 'seven_day', name: '7 дни с Ели' },
    status: 'active',
    billing_status: 'paid',
    modes: ['text', 'voice', 'community'],
    avatar_minutes_per_month: 0,
    starts_at: '2026-08-24T09:00:00.000Z',
    current_period_start: '2026-08-24T09:00:00.000Z',
    current_period_end: '2026-08-31T09:00:00.000Z',
    expires_at: '2026-08-31T09:00:00.000Z',
    cancel_at_period_end: false,
  });

  const normalized = normalizeEntitlementResponse(payload, { requestedTelegramUserId: TELEGRAM_USER_ID });
  assert.equal(normalized.active, true);
  assert.equal(normalized.planId, 'seven_day');
  assert.ok(!normalized.modes.includes('avatar'));
  assert.equal(normalized.avatarMinutesPerMonth, 0);
});

test('monthly entitlement response: avatar mode, 30 avatar minutes', () => {
  const normalized = normalizeEntitlementResponse(
    rawEntitlementResponse(),
    { requestedTelegramUserId: TELEGRAM_USER_ID },
  );
  assert.equal(normalized.planId, 'monthly');
  assert.ok(normalized.modes.includes('avatar'));
  assert.equal(normalized.avatarMinutesPerMonth, 30);
});

test('yearly entitlement response: avatar mode, 20 avatar minutes', () => {
  const payload = rawEntitlementResponse({
    telegram_user_id: TELEGRAM_USER_ID,
    active: true,
    plan_id: 'yearly',
    plan: { id: 'yearly', name: '1 година с Ели' },
    status: 'active',
    billing_status: 'active',
    modes: ['text', 'voice', 'avatar', 'community'],
    avatar_minutes_per_month: 20,
    starts_at: '2026-08-24T09:00:00.000Z',
    current_period_start: '2026-08-24T09:00:00.000Z',
    current_period_end: '2027-08-24T09:00:00.000Z',
    expires_at: '2027-08-24T09:00:00.000Z',
    cancel_at_period_end: false,
  });

  const normalized = normalizeEntitlementResponse(payload, { requestedTelegramUserId: TELEGRAM_USER_ID });
  assert.equal(normalized.planId, 'yearly');
  assert.ok(normalized.modes.includes('avatar'));
  assert.equal(normalized.avatarMinutesPerMonth, 20);
});

test('expired entitlement response: active=false, no modes', () => {
  const payload = rawEntitlementResponse({
    telegram_user_id: TELEGRAM_USER_ID,
    active: false,
    plan_id: 'monthly',
    plan: { id: 'monthly', name: '1 месец с Ели' },
    status: 'expired',
    billing_status: 'unpaid',
    modes: [],
    avatar_minutes_per_month: 0,
    starts_at: '2026-07-01T09:00:00.000Z',
    current_period_start: '2026-07-01T09:00:00.000Z',
    current_period_end: '2026-07-31T09:00:00.000Z',
    expires_at: '2026-07-31T09:00:00.000Z',
    cancel_at_period_end: false,
  });

  const normalized = normalizeEntitlementResponse(payload, { requestedTelegramUserId: TELEGRAM_USER_ID });
  assert.equal(normalized.active, false);
  assert.deepEqual(normalized.modes, []);
  assert.equal(normalized.avatarMinutesPerMonth, 0);
});

test('entitlement response rejects avatar minutes when avatar mode is not included', () => {
  const payload = rawEntitlementResponse({
    telegram_user_id: TELEGRAM_USER_ID,
    active: true,
    plan_id: 'seven_day',
    plan: { id: 'seven_day', name: '7 дни с Ели' },
    status: 'active',
    billing_status: 'paid',
    modes: ['text', 'voice', 'community'],
    avatar_minutes_per_month: 30,
    starts_at: '2026-08-24T09:00:00.000Z',
    current_period_start: '2026-08-24T09:00:00.000Z',
    current_period_end: '2026-08-31T09:00:00.000Z',
    expires_at: '2026-08-31T09:00:00.000Z',
    cancel_at_period_end: false,
  });

  assert.throws(
    () => normalizeEntitlementResponse(payload, { requestedTelegramUserId: TELEGRAM_USER_ID }),
    (err) => err.code === 'invalid_avatar_allowance',
  );
});

// ---------------------------------------------------------------------------
// Frontend cannot grant its own entitlement (app.js route check)
// ---------------------------------------------------------------------------

test('app.js has no public route for entitlement creation/update', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  // The only public routes are: ready, purchase-sessions/:token (GET),
  // purchase-sessions/:token/checkout (POST), checkout-sessions/:id/status (GET).
  // Entitlement creation happens ONLY inside webhookService after signature verification.
  assert.ok(!/POST.*entitlements/.test(source), 'No POST route for entitlements exists.');
  assert.ok(!/PUT.*entitlements/.test(source), 'No PUT route for entitlements exists.');
  assert.ok(source.includes('segments[1] === \'internal\''), 'Internal routes are gated.');
  assert.ok(source.includes('safeEqual(token, internalSecret)'), 'Internal routes require Bearer auth.');
});

// ---------------------------------------------------------------------------
// Payment-status: does not trust query parameters alone
// ---------------------------------------------------------------------------

test('payment-status.js fetches from backend API, not from URL query params', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'payment-status.js'),
    'utf8',
  );
  // The script must call the backend status endpoint
  assert.ok(source.includes('/checkout-sessions/'), 'Fetches status from backend API.');
  assert.ok(source.includes('API_BASE_URL'), 'Uses absolute API_BASE_URL for status fetch.');
  // It must not set active state based on URL params alone
  assert.ok(!/checkout_session_id.*=.*params.*.*active/.test(source), 'Does not set active from URL params.');
  // The "active" state only comes from a paid + active backend response
  assert.ok(source.includes("payload.state === 'paid'"), 'Active state requires backend paid state.');
  assert.ok(source.includes("payload.entitlement_status === 'active'"), 'Active state requires backend active entitlement.');
});

// ---------------------------------------------------------------------------
// Checkout is delegated to the pinned canonical purchase authority
// ---------------------------------------------------------------------------

test('purchase session service pins checkout to the canonical endpoint', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'purchaseSessionService.js'),
    'utf8',
  );
  assert.ok(
    source.includes('https://aoaylzncorwakxcactox.supabase.co/functions/v1/api/purchase-sessions'),
    'Checkout uses the approved canonical purchase authority.',
  );
  assert.ok(source.includes("method: 'POST'"), 'Checkout uses POST.');
  assert.ok(!source.includes('_safeReturnUrl'), 'Return URLs are not selected locally.');
  assert.ok(!source.includes('successUrl'), 'Client success URLs are not forwarded.');
  assert.ok(!source.includes('cancelUrl'), 'Client cancel URLs are not forwarded.');
});

// ---------------------------------------------------------------------------
// Stripe checkout metadata contains trusted identifiers
// ---------------------------------------------------------------------------

test('stripeService accepts and merges metadata into checkout session', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'stripeService.js'),
    'utf8',
  );
  assert.ok(source.includes('metadata = {}'), 'createCheckoutSession accepts a metadata parameter.');
  assert.ok(source.includes('...metadata'), 'Metadata is merged into the Stripe checkout params.');
});

// ---------------------------------------------------------------------------
// Webhook signature verification is required (no bypass)
// ---------------------------------------------------------------------------

test('app.js webhook route calls webhookService.handleWebhook which verifies signature', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(source.includes('webhookService.handleWebhook'), 'Webhook route delegates to webhookService.');
  assert.ok(source.includes("signature_invalid"), 'Returns signature_invalid on bad signature.');

  const webhookSource = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'webhookService.js'),
    'utf8',
  );
  assert.ok(webhookSource.includes('verifyWebhookEvent'), 'webhookService verifies the signature before processing.');
});
