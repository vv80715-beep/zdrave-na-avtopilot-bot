'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PLANS } = require('../plans');

const CHECKOUT_SOURCE = path.join(
  __dirname,
  '..',
  '..',
  'supabase',
  'functions',
  '_shared',
  'revolut-checkout.mjs',
);
const API_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'supabase', 'functions', 'api', 'index.ts'),
  'utf8',
);

let modulePromise;
function checkoutModule() {
  if (!modulePromise) modulePromise = import(CHECKOUT_SOURCE);
  return modulePromise;
}

const TOKEN = 'routing-test-token-abcdefghijklmnopqrstuvwxyz-12345';
const OTHER_TOKEN = 'routing-test-token-other-abcdefghijklmnopqrstuvwxyz';
const NOW = new Date('2026-08-19T10:00:00.000Z');
const SYMBOLIC_URL = 'operator-attested-link';
const TEST_CUSTOMER_ID = '9000000001';

async function allowedTestUrl(planId) {
  const { TEST_LINK_URLS } = await import('../../supabase/functions/_shared/revolut-test-links.mjs');
  return TEST_LINK_URLS[planId];
}

function configKey(mode, planId) {
  return `REVOLUT_${mode.toUpperCase()}_${planId.toUpperCase()}`;
}

function checkoutFor(mode, planId) {
  const plan = PLANS[planId];
  return {
    mode,
    url: `https://example.invalid/checkout/${mode}/${planId}`,
    amountCents: mode === 'test' ? 100 : plan.price.amount * 100,
    provider: mode === 'test' ? 'revolut_pro_test' : 'revolut_pro',
    reference: mode === 'test'
      ? `${planId}_eur_1_reusable_v1`
      : `${planId}_eur_${plan.price.amount}_reusable_v1`,
  };
}

async function configFor(mode, planId, overrides = {}) {
  const { sha256 } = await checkoutModule();
  const config = {
    mode,
    plan_id: planId,
    currency: 'EUR',
    amount_cents: mode === 'test' ? 100 : PLANS[planId].price.amount * 100,
    accept_multiple_payments: true,
    payment_limit: 'unlimited',
    status: 'active',
    expires_at: null,
    verified: true,
    url: mode === 'test' ? await allowedTestUrl(planId) : SYMBOLIC_URL,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'verified_url_sha256')) {
    config.verified_url_sha256 = await sha256(config.url);
  }
  return config;
}

function envWith(mode, planId, rawConfig) {
  const values = { REVOLUT_CHECKOUT_MODE: mode };
  if (rawConfig !== undefined) values[configKey(mode, planId)] = rawConfig;
  return (key) => values[key];
}

async function resolveConfigured(mode, planId, overrides = {}, extraEnv = {}) {
  const { resolveRevolutCheckout } = await checkoutModule();
  const config = await configFor(mode, planId, overrides);
  const values = {
    REVOLUT_CHECKOUT_MODE: mode,
    [configKey(mode, planId)]: JSON.stringify(config),
    ...extraEnv,
  };
  return resolveRevolutCheckout({
    plan: PLANS[planId],
    getEnv: (key) => values[key],
    validateUrl: async (value) => value === (mode === 'test' ? await allowedTestUrl(planId) : SYMBOLIC_URL),
  });
}

async function sessionFor(token = TOKEN, planId = 'monthly', overrides = {}) {
  const { sha256 } = await checkoutModule();
  return {
    id: `session-${planId}`,
    token_hash: await sha256(token.trim()),
    telegram_user_id: TEST_CUSTOMER_ID,
    plan_id: planId,
    status: 'pending',
    expires_at: '2026-08-19T11:00:00.000Z',
    stripe_checkout_session_id: null,
    ...overrides,
  };
}

function makeStore(session, { onClaim } = {}) {
  const state = { session, claims: [] };
  return {
    state,
    async find() {
      return state.session;
    },
    async claim(found, patch, claimedAt) {
      state.claims.push({ found, patch, claimedAt });
      if (onClaim) return onClaim(state, found, patch, claimedAt);
      if (state.session.status !== 'pending') return null;
      state.session = { ...state.session, ...patch };
      return state.session;
    },
  };
}

async function createCheckout({
  token = TOKEN,
  planId = 'monthly',
  sessionOverrides = {},
  resolver = async ({ plan }) => checkoutFor('production', plan.id),
  storeOptions,
  plans = PLANS,
  getEnv = (key) => key === 'REVOLUT_TEST_ALLOWED_TELEGRAM_IDS' ? TEST_CUSTOMER_ID : undefined,
  now = () => NOW,
} = {}) {
  const { createRevolutCheckout } = await checkoutModule();
  const session = await sessionFor(token, planId, sessionOverrides);
  const store = makeStore(session, storeOptions);
  const result = await createRevolutCheckout({
    token,
    store,
    plans,
    getEnv,
    now,
    resolveCheckout: resolver,
  });
  return { result, store, session };
}

test('server plans and edge API source expose exactly €15, €50, and €360', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(PLANS).map(([id, plan]) => [id, plan.price.amount])),
    { seven_day: 15, monthly: 50, yearly: 360 },
  );
  assert.equal(PLANS.seven_day.price.display, '€15');
  assert.equal(PLANS.monthly.price.display, '€50');
  assert.equal(PLANS.yearly.price.display, '€360');
  assert.match(API_SOURCE, /amount: 15, currency: "EUR", display: "€15"/);
  assert.match(API_SOURCE, /amount: 50, currency: "EUR", display: "€50"/);
  assert.match(API_SOURCE, /amount: 360, currency: "EUR", display: "€360"/);
});

test('resolver has no mode or plan default fallback', async () => {
  const { resolveRevolutCheckout } = await checkoutModule();
  let configReads = 0;
  const getEnv = (key) => {
    if (key !== 'REVOLUT_CHECKOUT_MODE') configReads += 1;
    return undefined;
  };
  for (const mode of [undefined, null, '', 'staging', 'TEST', 'production ']) {
    const result = await resolveRevolutCheckout({
      getEnv: (key) => key === 'REVOLUT_CHECKOUT_MODE' ? mode : getEnv(key),
      plan: PLANS.monthly,
      validateUrl: async () => true,
    });
    assert.equal(result, null, `unexpected fallback for mode ${String(mode)}`);
  }
  assert.equal(
    await resolveRevolutCheckout({
      getEnv: () => 'production',
      plan: { id: 'not_a_plan', price: { amount: 1 } },
      validateUrl: async () => true,
    }),
    null,
  );
  assert.equal(configReads, 0);
});

for (const mode of ['test', 'production']) {
  for (const planId of ['seven_day', 'monthly', 'yearly']) {
    test(`resolver routes ${mode}/${planId} with server-side amount and reference`, async () => {
      const result = await resolveConfigured(mode, planId);
      const expected = {
        ...checkoutFor(mode, planId),
        url: mode === 'test' ? await allowedTestUrl(planId) : SYMBOLIC_URL,
      };
      assert.deepEqual(result, expected);
      assert.equal(result.amountCents, mode === 'test' ? 100 : PLANS[planId].price.amount * 100);
    });
  }
}

test('test mode is explicitly €1 / 100 cents while production uses each public price', async () => {
  for (const planId of Object.keys(PLANS)) {
    const testResult = await resolveConfigured('test', planId);
    const productionResult = await resolveConfigured('production', planId);
    assert.equal(testResult.amountCents, 100);
    assert.equal(productionResult.amountCents, PLANS[planId].price.amount * 100);
    assert.notEqual(testResult.amountCents, PLANS[planId].price.amount * 100);
  }
});

test('resolver rejects malformed, missing, and mismatched configuration metadata', async () => {
  const { resolveRevolutCheckout } = await checkoutModule();
  const plan = PLANS.monthly;
  const valid = await configFor('production', plan.id);
  const cases = [
    ['missing config', undefined],
    ['invalid JSON', '{'],
    ['wrong mode', { ...valid, mode: 'test' }],
    ['wrong plan', { ...valid, plan_id: 'yearly' }],
    ['wrong currency', { ...valid, currency: 'USD' }],
    ['wrong amount', { ...valid, amount_cents: 100 }],
    ['not reusable', { ...valid, accept_multiple_payments: false }],
    ['limited payments', { ...valid, payment_limit: 1 }],
    ['inactive', { ...valid, status: 'inactive' }],
    ['has expiry', { ...valid, expires_at: '2030-01-01T00:00:00.000Z' }],
    ['unverified', { ...valid, verified: false }],
    ['invalid attestation', { ...valid, verified_url_sha256: 'bad-digest' }],
    ['invalid URL', { ...valid, url: 'javascript:alert(1)' }],
  ];
  for (const [label, value] of cases) {
    const result = await resolveRevolutCheckout({
      getEnv: (key) => {
        if (key === 'REVOLUT_CHECKOUT_MODE') return 'production';
        if (key === configKey('production', plan.id)) {
          return value === undefined || typeof value === 'string' ? value : JSON.stringify(value);
        }
        return undefined;
      },
      plan,
      validateUrl: async (candidate) => candidate === SYMBOLIC_URL,
    });
    assert.equal(result, null, label);
  }
});

test('resolver rejects a link reused by any other mode or plan', async () => {
  const config = await configFor('production', 'monthly');
  const result = await resolveConfigured(
    'production',
    'monthly',
    {},
    { [configKey('test', 'yearly')]: JSON.stringify({ ...config, mode: 'test', plan_id: 'yearly', amount_cents: 100 }) },
  );
  assert.equal(result, null);
});

test('validateLinkUrl rejects non-attested URL forms without embedding a provider URL', async () => {
  const { validateLinkUrl } = await checkoutModule();
  for (const candidate of [
    'https://example.invalid/checkout',
    'http://example.invalid/checkout',
    'javascript:alert(1)',
    ' https://example.invalid/checkout',
    'https://example.invalid/checkout?token=1',
  ]) {
    assert.equal(await validateLinkUrl(candidate), false, candidate);
  }
  const source = fs.readFileSync(CHECKOUT_SOURCE, 'utf8');
  assert.doesNotMatch(source, /https:\/\/[^\s"'`]*\/pay\//);
  assert.equal(source.includes('RETIRED_LINK_DIGESTS'), true);
});

test('retired-link rejection is checked against an optional local baseline without a fixture URL', async (t) => {
  const baselinePath = '/tmp/payment-api-current.json';
  if (!fs.existsSync(baselinePath)) {
    t.skip('optional payment API baseline is not present');
    return;
  }
  const baseline = fs.readFileSync(baselinePath, 'utf8');
  const candidates = baseline.match(/https:\/\/[^\s"'\\]+/g) || [];
  const { RETIRED_LINK_DIGESTS, sha256, validateLinkUrl } = await checkoutModule();
  let retired = null;
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.replace(/[),.;]+$/, ''));
      const segment = url.pathname.startsWith('/pay/') ? url.pathname.slice(5) : '';
      if (segment && (await sha256(segment)).length === 64 &&
          RETIRED_LINK_DIGESTS.includes(await sha256(segment))) {
        retired = candidate.replace(/[),.;]+$/, '');
        break;
      }
    } catch {
      // Ignore unrelated URLs in the local baseline.
    }
  }
  if (!retired) {
    t.skip('baseline has no retired checkout link');
    return;
  }
  assert.equal(await validateLinkUrl(retired), false);
});

test('invalid or missing config returns 503 before any claim/database write', async () => {
  const { resolveRevolutCheckout } = await checkoutModule();
  const cases = [
    ['missing mode', {}],
    ['missing config', { REVOLUT_CHECKOUT_MODE: 'production' }],
    ['invalid JSON', {
      REVOLUT_CHECKOUT_MODE: 'production',
      [configKey('production', 'monthly')]: '{',
    }],
    ['invalid URL metadata', {
      REVOLUT_CHECKOUT_MODE: 'production',
      [configKey('production', 'monthly')]: JSON.stringify(
        await configFor('production', 'monthly', { url: 'http://example.invalid/nope' }),
      ),
    }],
  ];
  for (const [label, values] of cases) {
    const { result, store } = await createCheckout({
      getEnv: (key) => values[key],
      resolver: (args) => resolveRevolutCheckout({
        ...args,
        validateUrl: async (value) => value === SYMBOLIC_URL,
      }),
    });
    assert.equal(result.status, 503, label);
    assert.equal(result.body.error, 'checkout_not_configured', label);
    assert.equal(store.state.claims.length, 0, `${label} wrote a claim`);
  }
});

test('session token validation hashes the normalized token and rejects invalid tokens', async () => {
  let finds = 0;
  const { createRevolutCheckout } = await checkoutModule();
  const store = {
    async find() {
      finds += 1;
      return null;
    },
    async claim() {
      throw new Error('claim must not be called');
    },
  };
  for (const token of ['', 'short', 'A'.repeat(31), `${'A'.repeat(32)}!`, null]) {
    const result = await createRevolutCheckout({
      token,
      store,
      plans: PLANS,
      getEnv: () => undefined,
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid_session_token');
  }
  assert.equal(finds, 0);

  const session = await sessionFor(TOKEN);
  const normalizedStore = makeStore(session);
  const result = await createRevolutCheckout({
    token: `  ${TOKEN}  `,
    store: normalizedStore,
    plans: PLANS,
    getEnv: () => undefined,
    now: () => NOW,
    resolveCheckout: async ({ plan }) => checkoutFor('production', plan.id),
  });
  assert.equal(result.ok, true);
});

test('expired and invalidly dated sessions are rejected without a claim', async () => {
  for (const expires_at of ['2026-08-19T09:59:59.000Z', 'not-a-date']) {
    const { result, store } = await createCheckout({
      sessionOverrides: { expires_at },
    });
    assert.equal(result.status, 410);
    assert.equal(result.body.error, 'session_expired');
    assert.equal(store.state.claims.length, 0);
  }
});

test('status, provider-session id, and unknown plan are server-side session decisions', async () => {
  for (const status of ['paid', 'cancelled', 'failed']) {
    const { result, store } = await createCheckout({
      sessionOverrides: { status },
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'session_not_available');
    assert.equal(store.state.claims.length, 0);
  }
  const withProviderId = await createCheckout({
    sessionOverrides: { stripe_checkout_session_id: 'provider-session-id' },
  });
  assert.equal(withProviderId.result.status, 409);
  assert.equal(withProviderId.store.state.claims.length, 0);

  const unknown = await createCheckout({ planId: 'attacker_plan' });
  assert.equal(unknown.result.status, 400);
  assert.equal(unknown.result.body.error, 'invalid_plan');
  assert.equal(unknown.store.state.claims.length, 0);
});

test('checkout uses stored plan and ignores caller plan or URL extras', async () => {
  let resolvedPlan;
  const { result } = await createCheckout({
    planId: 'yearly',
    resolver: async ({ plan, requestedPlanId, checkoutUrl }) => {
      resolvedPlan = { plan, requestedPlanId, checkoutUrl };
      return checkoutFor('production', plan.id);
    },
    requestedPlanId: 'seven_day',
    checkoutUrl: 'https://example.invalid/attacker',
  });
  assert.equal(result.ok, true);
  assert.equal(resolvedPlan.plan.id, 'yearly');
  assert.equal(resolvedPlan.requestedPlanId, undefined);
  assert.equal(resolvedPlan.checkoutUrl, undefined);
  assert.equal(result.body.plan_id, 'yearly');
  assert.equal(result.body.amount.amount_cents, 36000);
});

test('test and production response bodies expose provider status, references, and amount authority', async () => {
  for (const mode of ['test', 'production']) {
    for (const planId of Object.keys(PLANS)) {
      const { result } = await createCheckout({
        planId,
        resolver: async ({ plan }) => checkoutFor(mode, plan.id),
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.checkout_mode, mode);
      assert.equal(result.body.checkout_provider, mode === 'test' ? 'revolut_pro_test' : 'revolut_pro');
      assert.equal(
        result.body.checkout_reference,
        mode === 'test'
          ? `${planId}_eur_1_reusable_v1`
          : `${planId}_eur_${PLANS[planId].price.amount}_reusable_v1`,
      );
      if (mode === 'test') {
        assert.deepEqual(result.body.test_amount, { amount_cents: 100, currency: 'eur' });
        assert.equal(result.body.payment_confirmation, 'manual_owner_confirmation_required');
        assert.equal('amount' in result.body, false);
      } else {
        assert.deepEqual(result.body.amount, {
          amount_cents: PLANS[planId].price.amount * 100,
          currency: 'eur',
        });
        assert.equal(result.body.payment_confirmation, 'provider_confirmation_required');
        assert.equal('test_amount' in result.body, false);
      }
    }
  }
});

test('compare-and-set claim allows only one concurrent pending request', async () => {
  let resolverCalls = 0;
  let release;
  const bothResolved = new Promise((resolve) => { release = resolve; });
  const resolver = async ({ plan }) => {
    resolverCalls += 1;
    if (resolverCalls === 2) release();
    await bothResolved;
    return checkoutFor('production', plan.id);
  };
  const session = await sessionFor();
  const state = { session, claims: 0 };
  const store = {
    async find() {
      return state.session;
    },
    async claim(_session, patch) {
      state.claims += 1;
      if (state.session.status !== 'pending') return null;
      state.session = { ...state.session, ...patch };
      return state.session;
    },
  };
  const { createRevolutCheckout } = await checkoutModule();
  const args = {
    token: TOKEN,
    store,
    plans: PLANS,
    getEnv: () => undefined,
    now: () => NOW,
    resolveCheckout: resolver,
  };
  const [first, second] = await Promise.all([
    createRevolutCheckout(args),
    createRevolutCheckout(args),
  ]);
  assert.equal(resolverCalls, 2);
  assert.equal(state.claims, 2);
  assert.deepEqual(
    [first.status, second.status].sort((a, b) => a - b),
    [200, 409],
  );
  assert.equal(
    [first, second].find((result) => result.status === 409).body.error,
    'session_not_available',
  );
});

test('repeat requests re-resolve current mode before serving or claiming', async () => {
  const values = {
    REVOLUT_CHECKOUT_MODE: 'production',
    REVOLUT_TEST_ALLOWED_TELEGRAM_IDS: TEST_CUSTOMER_ID,
  };
  const approvedMonthlyUrl = await allowedTestUrl('monthly');
  const { resolveRevolutCheckout } = await checkoutModule();
  const resolver = (args) => resolveRevolutCheckout({
    ...args,
    getEnv: (key) => values[key],
    validateUrl: async (value) => (
      value === SYMBOLIC_URL || value === approvedMonthlyUrl
    ),
  });
  const config = await configFor('production', 'monthly');
  values[configKey('production', 'monthly')] = JSON.stringify(config);
  const first = await createCheckout({ resolver });
  assert.equal(first.result.status, 200);
  assert.equal(first.store.state.claims.length, 1);

  const { createRevolutCheckout } = await checkoutModule();
  const sameMode = await createRevolutCheckout({
    token: TOKEN,
    store: first.store,
    plans: PLANS,
    getEnv: (key) => values[key],
    now: () => NOW,
    resolveCheckout: resolver,
  });
  assert.equal(sameMode.status, 200);
  assert.equal(first.store.state.claims.length, 1);

  values.REVOLUT_CHECKOUT_MODE = 'test';
  values[configKey('test', 'monthly')] = JSON.stringify(await configFor('test', 'monthly'));
  const changedMode = await createRevolutCheckout({
    token: TOKEN,
    store: first.store,
    plans: PLANS,
    getEnv: (key) => values[key],
    now: () => NOW,
    resolveCheckout: resolver,
  });
  assert.equal(changedMode.status, 409);
  assert.equal(changedMode.body.error, 'session_already_claimed');
  assert.equal(first.store.state.claims.length, 1);

  values.REVOLUT_CHECKOUT_MODE = 'production';
  delete values[configKey('production', 'monthly')];
  const disabled = await createRevolutCheckout({
    token: TOKEN,
    store: first.store,
    plans: PLANS,
    getEnv: (key) => values[key],
    now: () => NOW,
    resolveCheckout: resolver,
  });
  assert.equal(disabled.status, 503);
  assert.equal(disabled.body.error, 'checkout_not_configured');
  assert.equal(first.store.state.claims.length, 1);
});

test('already-claimed session rejects a different provider reference without writing', async () => {
  const claimed = await createCheckout({
    sessionOverrides: {
      status: 'checkout_created',
      checkout_provider: 'revolut_pro_test',
      checkout_reference: 'monthly_eur_1_reusable_v1',
    },
    resolver: async ({ plan }) => checkoutFor('production', plan.id),
  });
  assert.equal(claimed.result.status, 409);
  assert.equal(claimed.result.body.error, 'session_already_claimed');
  assert.equal(claimed.store.state.claims.length, 0);
});
