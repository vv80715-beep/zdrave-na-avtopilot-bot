// Offline owner-only direct Stripe checkout contract.
// All HTTP calls are mocked; this never creates a real purchase or checkout.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const {
  EliPlatformClient,
  BoltPlatformError,
} = require('../boltPlatformClient');
const plans = require('../commands/plans');

const SECRET = 'offline-secret-value-that-is-long-enough';
const TOKEN = 'T'.repeat(43);
const BASE_URL = 'https://platform.example/functions/v1/api';
const STRIPE_URL = 'https://checkout.stripe.com/c/pay/cs_live_123456';

function jsonResponse(data, status = 200) {
  const text = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => String(Buffer.byteLength(text, 'utf8')) },
    text: async () => text,
  };
}

function checkoutResponse(overrides = {}) {
  return {
    api_version: 1,
    plan_id: 'seven_day',
    checkout_provider: 'stripe',
    checkout_mode: 'live',
    checkout_session_id: 'cs_live_123456',
    checkout_url: STRIPE_URL,
    owner_test_checkout: true,
    charge_amount_cents: 0,
    ...overrides,
  };
}

function purchaseSessionStatus(overrides = {}) {
  return {
    api_version: 1,
    plan_id: 'seven_day',
    status: 'pending',
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    owner_test_checkout: true,
    checkout_amount_cents: 0,
    ...overrides,
  };
}

function context(id = 900000001) {
  const replies = [];
  return {
    from: { id },
    chat: { id, type: 'private' },
    replies,
    reply: async (message, extra) => replies.push({ message, extra }),
  };
}

test('owner session status and checkout use exact public API paths', async () => {
  const requests = [];
  const client = new EliPlatformClient({
    baseUrl: BASE_URL,
    allowUnapprovedEndpointForTests: true,
    secret: SECRET,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === 'GET') {
        return jsonResponse(purchaseSessionStatus());
      }
      return jsonResponse(checkoutResponse());
    },
  });

  const status = await client.getPurchaseSession(TOKEN, 'seven_day');
  assert.equal(status.owner_test_checkout, true);
  assert.equal(status.checkout_amount_cents, 0);
  const checkout = await client.createOwnerTestCheckout(TOKEN, 'seven_day');
  assert.equal(checkout.checkout_url, STRIPE_URL);

  assert.deepEqual(requests.map(({ url, options }) => [
    url,
    options.method,
    options.body,
  ]), [
    [`${BASE_URL}/purchase-sessions/${TOKEN}`, 'GET', undefined],
    [`${BASE_URL}/purchase-sessions/${TOKEN}/checkout`, 'POST', '{}'],
  ]);
  assert.equal(requests[1].options.redirect, 'error');
  assert.equal(requests[1].options.headers.Authorization, undefined);
});

test('owner receives direct Stripe URL only after zero-price owner status', async () => {
  const calls = [];
  const client = {
    createPurchaseSession: async (id, plan) => {
      calls.push(['create', id, plan]);
      return {
        purchase_url: `https://platform.example/confirm-plan.html?session=${TOKEN}`,
        plan: { id: plan, name: '7 дни с Ели' },
      };
    },
    getPurchaseSession: async (token, plan) => {
      calls.push(['verify', token, plan]);
      return purchaseSessionStatus();
    },
    createOwnerTestCheckout: async (token, plan) => {
      calls.push(['checkout', token, plan]);
      return checkoutResponse();
    },
  };
  const ctx = context();
  await plans.sendPurchaseLink(ctx, 'seven_day', client, { isOwner: () => true });

  assert.deepEqual(calls, [
    ['create', String(ctx.from.id), 'seven_day'],
    ['verify', TOKEN, 'seven_day'],
    ['checkout', TOKEN, 'seven_day'],
  ]);
  assert.equal(ctx.replies.length, 1);
  assert.match(ctx.replies[0].message, /само след потвърден Stripe webhook/);
  const buttons = ctx.replies[0].extra.reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map((button) => button.url), [STRIPE_URL]);
  assert.deepEqual(buttons.map((button) => button.text), ['Отвори Stripe checkout']);
});

test('non-owner remains on the existing purchase confirmation flow', async () => {
  const calls = [];
  const client = {
    createPurchaseSession: async () => ({
      purchase_url: `https://platform.example/confirm-plan.html?session=${TOKEN}`,
      plan: { id: 'monthly', name: '1 месец с Ели' },
    }),
    getPurchaseSession: async () => {
      calls.push('verify');
      assert.fail('ordinary customers must not enter the owner test path');
    },
    createOwnerTestCheckout: async () => assert.fail('no direct checkout'),
  };
  const ctx = context(900000002);
  await plans.sendPurchaseLink(ctx, 'monthly', client, { isOwner: () => false });
  assert.deepEqual(calls, []);
  assert.equal(
    ctx.replies[0].extra.reply_markup.inline_keyboard[0][0].url,
    `https://platform.example/confirm-plan.html?session=${TOKEN}`
  );
});

test('owner with a verified normal-price session stays on the normal flow', async () => {
  const calls = [];
  const client = {
    createPurchaseSession: async () => ({
      purchase_url: `https://platform.example/confirm-plan.html?session=${TOKEN}`,
      plan: { id: 'seven_day', name: '7 дни с Ели' },
    }),
    getPurchaseSession: async () => ({
      ...purchaseSessionStatus(),
      owner_test_checkout: false,
      checkout_amount_cents: 1500,
    }),
    createOwnerTestCheckout: async () => {
      calls.push('checkout');
      assert.fail('owner test checkout is not eligible');
    },
  };
  const ctx = context();
  await plans.sendPurchaseLink(ctx, 'seven_day', client, { isOwner: () => true });
  assert.deepEqual(calls, []);
  assert.equal(
    ctx.replies[0].extra.reply_markup.inline_keyboard[0][0].url,
    `https://platform.example/confirm-plan.html?session=${TOKEN}`
  );
});

test('owner status with inconsistent zero-price flags fails closed', async () => {
  for (const status of [
    purchaseSessionStatus({ owner_test_checkout: true, checkout_amount_cents: 1500 }),
    purchaseSessionStatus({ owner_test_checkout: false, checkout_amount_cents: 0 }),
  ]) {
    let directCalls = 0;
    const ctx = context();
    const client = {
      createPurchaseSession: async () => ({
        purchase_url: `https://platform.example/confirm-plan.html?session=${TOKEN}`,
        plan: { id: 'seven_day', name: '7 дни с Ели' },
      }),
      getPurchaseSession: async () => status,
      createOwnerTestCheckout: async () => { directCalls += 1; },
    };
    const warnings = [];
    const oldWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      await plans.sendPurchaseLink(ctx, 'seven_day', client, { isOwner: () => true });
    } finally {
      console.warn = oldWarn;
    }
    assert.equal(directCalls, 0);
    assert.equal(ctx.replies.length, 1);
    assert.equal(
      ctx.replies[0].extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.url,
      undefined
    );
    assert.equal(ctx.replies[0].message, plans.PURCHASE_ERROR_MESSAGE);
  }
});

test('Stripe checkout response validation rejects any mismatched authorization field', async () => {
  const invalid = [
    { checkout_provider: 'revolut_pro_test' },
    { checkout_mode: 'test' },
    { checkout_session_id: 'cs_test_123456' },
    { checkout_url: 'https://evil.example/c/pay/cs_live_123456' },
    { checkout_url: 'http://checkout.stripe.com/c/pay/cs_live_123456' },
    { owner_test_checkout: false },
    { charge_amount_cents: 1500 },
    { plan_id: 'monthly' },
    { checkout_url: 'https://checkout.stripe.com/other-path' },
  ];

  for (const override of invalid) {
    const client = new EliPlatformClient({
      baseUrl: BASE_URL,
      allowUnapprovedEndpointForTests: true,
      secret: SECRET,
      fetchImpl: async () => jsonResponse(checkoutResponse(override)),
    });
    await assert.rejects(
      client.createOwnerTestCheckout(TOKEN, 'seven_day'),
      (error) =>
        error instanceof BoltPlatformError &&
        error.code === 'invalid_owner_checkout_response'
    );
  }
});

test('purchase session status validation requires owner zero-test confirmation', async () => {
  const invalid = [
    { plan_id: 'monthly' },
    { owner_test_checkout: 'true' },
    { checkout_amount_cents: '0' },
    { checkout_amount_cents: -1 },
    { status: 'paid' },
    { expires_at: new Date(0).toISOString() },
  ];
  for (const override of invalid) {
    const client = new EliPlatformClient({
      baseUrl: BASE_URL,
      allowUnapprovedEndpointForTests: true,
      secret: SECRET,
      fetchImpl: async () => jsonResponse(purchaseSessionStatus(override)),
    });
    await assert.rejects(
      client.getPurchaseSession(TOKEN, 'seven_day'),
      (error) =>
        error instanceof BoltPlatformError &&
        error.code === 'invalid_purchase_session_response'
    );
  }
});
