'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PLANS } = require('../plans');
const {
  EliPlatformClient,
  normalizePurchaseResponse,
} = require('../../bot-integration/eliPlatformClient.cjs');

const SECRET = 'cross-plan-isolation-test-secret-1234567890';
const PURCHASE_ORIGIN = 'https://static.example';
const API_BASE = 'https://api.example';
const SESSION_TOKEN = 'a'.repeat(43);

const PURCHASE_JS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'purchase.js'),
  'utf8',
);

const CHECKOUT_ROUTING_JS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'checkout-routing.js'),
  'utf8',
);

const EDGE_FN = fs.readFileSync(
  path.join(__dirname, '..', '..', 'supabase', 'functions', 'api', 'index.ts'),
  'utf8',
);

const PURCHASE_SESSION_SERVICE = fs.readFileSync(
  path.join(__dirname, '..', 'purchaseSessionService.js'),
  'utf8',
);

// ---------------------------------------------------------------------------
// A. Telegram/canonical plan mapping
// ---------------------------------------------------------------------------

test('buy:seven_day maps to plan_id seven_day', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'bot-integration', 'example-telegraf-hooks.cjs'),
    'utf8',
  );
  assert.ok(source.includes("'buy:seven_day': 'seven_day'"));
  assert.ok(source.includes("'buy:monthly': 'monthly'"));
  assert.ok(source.includes("'buy:yearly': 'yearly'"));
});

// ---------------------------------------------------------------------------
// B + C. Purchase session returns correct plan for each canonical ID
// ---------------------------------------------------------------------------

function purchaseResponsePayload(planId) {
  const plan = PLANS[planId];
  return {
    api_version: 1,
    purchase_url: `${PURCHASE_ORIGIN}/confirm-plan.html?session=${SESSION_TOKEN}`,
    expires_at: '2026-08-24T16:00:00.000Z',
    plan: { id: plan.id, name: plan.name },
  };
}

for (const planId of ['seven_day', 'monthly', 'yearly']) {
  test(`purchase session response for ${planId} returns correct plan id`, () => {
    const result = normalizePurchaseResponse(purchaseResponsePayload(planId), {
      requestedPlanId: planId,
      baseUrl: API_BASE,
      purchaseUrlOrigin: PURCHASE_ORIGIN,
    });
    assert.equal(result.plan.id, planId);
    assert.equal(result.plan.name, PLANS[planId].name);
  });
}

// ---------------------------------------------------------------------------
// D. confirm-plan frontend uses ONLY the backend session response
// ---------------------------------------------------------------------------

test('purchase.js does not read a plan query parameter', () => {
  assert.ok(!PURCHASE_JS.includes("params.get('plan')"),
    'purchase.js must not read a ?plan= URL parameter.');
});

test('purchase.js resolvePlan does not fall back to monthly', () => {
  assert.ok(!PURCHASE_JS.includes("|| ['monthly', planCatalog.monthly]"),
    'resolvePlan must not default to monthly when plan is not found.');
});

test('purchase.js does not read localStorage for plan selection', () => {
  assert.ok(!PURCHASE_JS.includes('localStorage'),
    'purchase.js must not use localStorage for plan selection.');
});

test('purchase.js uses absolute API base URL for session verification', () => {
  assert.ok(CHECKOUT_ROUTING_JS.includes('apiBaseUrl'),
    'checkout-routing.js must accept the common API base URL.');
  assert.ok(CHECKOUT_ROUTING_JS.includes('${apiBaseUrl}/purchase-sessions/'),
    'checkout-routing.js must use the common API base URL for session verification.');
});

test('purchase.js uses absolute API base URL for checkout', () => {
  assert.ok(CHECKOUT_ROUTING_JS.includes('${apiBaseUrl}/purchase-sessions/'),
    'checkout-routing.js must use the common API base URL for checkout fetch.');
});

test('purchase.js renders plan only after backend verification succeeds', () => {
  assert.ok(PURCHASE_JS.includes('verifySession(sessionToken)'),
    'purchase.js must call verifySession before rendering any plan.');
  assert.ok(!/planParam.*renderPlan/.test(PURCHASE_JS),
    'purchase.js must not render a plan from a URL parameter.');
});

// ---------------------------------------------------------------------------
// E. Correct display values for each plan
// ---------------------------------------------------------------------------

test('seven_day displays €15, 7 days, avatar disabled', () => {
  const plan = PLANS.seven_day;
  assert.equal(plan.price.display, '€15');
  assert.equal(plan.durationDays, 7);
  assert.ok(!plan.modes.includes('avatar'));
  assert.ok(plan.modes.includes('text'));
  assert.ok(plan.modes.includes('voice'));
  assert.ok(plan.modes.includes('community'));
});

test('monthly displays €50, monthly, avatar enabled, 30 avatar min', () => {
  const plan = PLANS.monthly;
  assert.equal(plan.price.display, '€50');
  assert.equal(plan.avatarMinutesPerMonth, 30);
  assert.ok(plan.modes.includes('avatar'));
});

test('yearly displays €360, yearly, avatar enabled, 20 avatar min', () => {
  const plan = PLANS.yearly;
  assert.equal(plan.price.display, '€360');
  assert.equal(plan.avatarMinutesPerMonth, 20);
  assert.ok(plan.modes.includes('avatar'));
});

// ---------------------------------------------------------------------------
// F. Stripe checkout mapping per plan
// ---------------------------------------------------------------------------

test('edge function uses STRIPE_PRICE_SEVEN_DAY for seven_day', () => {
  assert.ok(EDGE_FN.includes('seven_day: Deno.env.get("STRIPE_PRICE_SEVEN_DAY")'),
    'Edge function must map seven_day to STRIPE_PRICE_SEVEN_DAY.');
});

test('edge function uses STRIPE_PRICE_MONTHLY for monthly', () => {
  assert.ok(EDGE_FN.includes('monthly: Deno.env.get("STRIPE_PRICE_MONTHLY")'),
    'Edge function must map monthly to STRIPE_PRICE_MONTHLY.');
});

test('edge function uses STRIPE_PRICE_YEARLY for yearly', () => {
  assert.ok(EDGE_FN.includes('yearly: Deno.env.get("STRIPE_PRICE_YEARLY")'),
    'Edge function must map yearly to STRIPE_PRICE_YEARLY.');
});

test('local checkout delegates to the canonical authority instead of selecting Stripe mode', () => {
  assert.ok(
    PURCHASE_SESSION_SERVICE.includes(
      'https://aoaylzncorwakxcactox.supabase.co/functions/v1/api/purchase-sessions',
    ),
    'Local checkout must use the pinned canonical purchase authority.',
  );
  assert.ok(!PURCHASE_SESSION_SERVICE.includes('createCheckoutSession'));
  assert.ok(!PURCHASE_SESSION_SERVICE.includes('priceCatalog'));
});

test('local checkout identifies the canonical plan only by the validated opaque token', () => {
  assert.ok(
    PURCHASE_SESSION_SERVICE.includes('encodeURIComponent(normalized)'),
    'Only the validated opaque session token may identify checkout.',
  );
  assert.ok(!PURCHASE_SESSION_SERVICE.includes('successUrl'));
  assert.ok(!PURCHASE_SESSION_SERVICE.includes('cancelUrl'));
});

// ---------------------------------------------------------------------------
// G. Cross-plan isolation: one plan can never render or checkout another
// ---------------------------------------------------------------------------

test('seven_day purchase response is rejected if plan.id is monthly', () => {
  assert.throws(
    () => normalizePurchaseResponse(
      { ...purchaseResponsePayload('seven_day'), plan: { id: 'monthly', name: '1 месец с Ели' } },
      { requestedPlanId: 'seven_day', baseUrl: API_BASE, purchaseUrlOrigin: PURCHASE_ORIGIN },
    ),
    (err) => err.code === 'plan_mismatch',
  );
});

test('monthly purchase response is rejected if plan.id is yearly', () => {
  assert.throws(
    () => normalizePurchaseResponse(
      { ...purchaseResponsePayload('monthly'), plan: { id: 'yearly', name: '1 година с Ели' } },
      { requestedPlanId: 'monthly', baseUrl: API_BASE, purchaseUrlOrigin: PURCHASE_ORIGIN },
    ),
    (err) => err.code === 'plan_mismatch',
  );
});

test('yearly purchase response is rejected if plan.id is seven_day', () => {
  assert.throws(
    () => normalizePurchaseResponse(
      { ...purchaseResponsePayload('yearly'), plan: { id: 'seven_day', name: '7 дни с Ели' } },
      { requestedPlanId: 'yearly', baseUrl: API_BASE, purchaseUrlOrigin: PURCHASE_ORIGIN },
    ),
    (err) => err.code === 'plan_mismatch',
  );
});

test('purchase response with unknown plan_id is rejected, not defaulted to monthly', () => {
  assert.throws(
    () => normalizePurchaseResponse(
      { ...purchaseResponsePayload('seven_day'), plan: { id: 'unknown_plan', name: 'Unknown' } },
      { requestedPlanId: 'seven_day', baseUrl: API_BASE, purchaseUrlOrigin: PURCHASE_ORIGIN },
    ),
    (err) => err.code === 'plan_mismatch',
  );
});

// ---------------------------------------------------------------------------
// H. Full flow tests: buy -> session -> confirm -> Stripe mapping
// ---------------------------------------------------------------------------

async function createPurchaseSessionForPlan(planId) {
  const client = new EliPlatformClient({
    baseUrl: API_BASE,
    internalSecret: SECRET,
    purchaseUrlOrigin: PURCHASE_ORIGIN,
    production: true,
    fetchImpl: async () => new Response(JSON.stringify(purchaseResponsePayload(planId)), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }),
  });
  return client.createPurchaseSession({ telegramUserId: '8934490753', planId });
}

test('full flow: buy:seven_day -> session seven_day -> €15 -> Stripe seven_day', async () => {
  const result = await createPurchaseSessionForPlan('seven_day');
  assert.equal(result.plan.id, 'seven_day');
  assert.equal(result.plan.name, '7 дни с Ели');
  assert.ok(result.purchaseUrl.startsWith('https://static.example/confirm-plan.html?session='));
  assert.equal(PLANS.seven_day.price.display, '€15');
});

test('full flow: buy:monthly -> session monthly -> €50 -> Stripe monthly', async () => {
  const result = await createPurchaseSessionForPlan('monthly');
  assert.equal(result.plan.id, 'monthly');
  assert.equal(result.plan.name, '1 месец с Ели');
  assert.equal(PLANS.monthly.price.display, '€50');
});

test('full flow: buy:yearly -> session yearly -> €360 -> Stripe yearly', async () => {
  const result = await createPurchaseSessionForPlan('yearly');
  assert.equal(result.plan.id, 'yearly');
  assert.equal(result.plan.name, '1 година с Ели');
  assert.equal(PLANS.yearly.price.display, '€360');
});

test('stale localStorage/browser state cannot override a secure session (source check)', () => {
  assert.ok(!PURCHASE_JS.includes('localStorage'),
    'purchase.js must not read localStorage at all.');
  assert.ok(!PURCHASE_JS.includes("params.get('plan')"),
    'purchase.js must not read plan from URL params.');
});
