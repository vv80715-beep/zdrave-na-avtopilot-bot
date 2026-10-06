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
const SETTINGS_SOURCE = path.join(
  __dirname,
  '..',
  '..',
  'scripts',
  'print-revolut-test-settings.mjs',
);
const API_SOURCE = path.join(
  __dirname,
  '..',
  '..',
  'supabase',
  'functions',
  'api',
  'index.ts',
);
const TEST_CUSTOMER_ID = '9000000001';
const TOKEN = 'test-access-token-abcdefghijklmnopqrstuvwxyz-12345';
const NOW = new Date('2026-08-19T10:00:00.000Z');

let checkoutModulePromise;
function checkoutModule() {
  if (!checkoutModulePromise) checkoutModulePromise = import(CHECKOUT_SOURCE);
  return checkoutModulePromise;
}

let settingsModulePromise;
function settingsModule() {
  if (!settingsModulePromise) settingsModulePromise = import(SETTINGS_SOURCE);
  return settingsModulePromise;
}

function configKey(mode, planId) {
  return `REVOLUT_${mode.toUpperCase()}_${planId.toUpperCase()}`;
}

async function testSettings(options = { providerVerified: true, testerIds: TEST_CUSTOMER_ID }) {
  const { buildTestSettings } = await settingsModule();
  return buildTestSettings(options);
}

function envFrom(values) {
  return (key) => values[key];
}

async function sessionFor({
  token = TOKEN,
  planId = 'monthly',
  telegramUserId,
  status = 'pending',
  ...overrides
} = {}) {
  const { sha256 } = await checkoutModule();
  return {
    id: `test-session-${planId}`,
    token_hash: await sha256(token.trim()),
    telegram_user_id: telegramUserId,
    plan_id: planId,
    status,
    expires_at: '2026-08-19T11:00:00.000Z',
    stripe_checkout_session_id: null,
    ...overrides,
  };
}

function fakeStore(session) {
  const state = { session, claims: [], writes: [] };
  return {
    state,
    async find(tokenHash) {
      assert.equal(tokenHash, state.session.token_hash);
      return state.session;
    },
    async claim(found, patch, claimedAt) {
      state.claims.push({ found, patch, claimedAt });
      if (state.session.status !== 'pending') return null;
      state.session = { ...state.session, ...patch };
      state.writes.push(state.session);
      return state.session;
    },
  };
}

async function configuredTestEnv(planId, url, overrides = {}) {
  const { sha256 } = await checkoutModule();
  return {
    REVOLUT_CHECKOUT_MODE: 'test',
    REVOLUT_TEST_ALLOWED_TELEGRAM_IDS: TEST_CUSTOMER_ID,
    [configKey('test', planId)]: JSON.stringify({
      mode: 'test',
      plan_id: planId,
      url,
      currency: 'EUR',
      amount_cents: 100,
      accept_multiple_payments: true,
      payment_limit: 'unlimited',
      status: 'active',
      expires_at: null,
      verified: true,
      verified_url_sha256: await sha256(url),
      ...overrides,
    }),
  };
}

async function createTestCheckout(options = {}) {
  const {
    planId = 'monthly',
    env,
    resolver,
    status = 'pending',
  } = options;
  const telegramUserId = Object.hasOwn(options, 'telegramUserId')
    ? options.telegramUserId
    : TEST_CUSTOMER_ID;
  const { createRevolutCheckout, resolveRevolutCheckout } = await checkoutModule();
  const session = await sessionFor({ planId, telegramUserId, status });
  const store = fakeStore(session);
  const result = await createRevolutCheckout({
    token: TOKEN,
    store,
    plans: PLANS,
    getEnv: envFrom(env),
    now: () => NOW,
    resolveCheckout: resolver || resolveRevolutCheckout,
  });
  return { result, store };
}

test('the three supplied TEST links pass the real validator and create only €1 checkout claims', async () => {
  const { TEST_LINK_URLS } = await import('../../supabase/functions/_shared/revolut-test-links.mjs');
  const { validateLinkUrl, resolveRevolutCheckout } = await checkoutModule();

  for (const [planId, expectedUrl] of Object.entries(TEST_LINK_URLS)) {
    assert.equal(await validateLinkUrl(expectedUrl), true, planId);
    const env = await configuredTestEnv(planId, expectedUrl);
    const resolved = await resolveRevolutCheckout({
      plan: PLANS[planId],
      getEnv: envFrom(env),
    });
    assert.equal(resolved.url, expectedUrl);
    assert.equal(resolved.amountCents, 100);

    const { result, store } = await createTestCheckout({ planId, env });
    assert.equal(result.status, 200, planId);
    assert.equal(result.body.plan_id, planId);
    assert.equal(result.body.checkout_url, expectedUrl);
    assert.deepEqual(result.body.test_amount, { amount_cents: 100, currency: 'eur' });
    assert.equal(result.body.payment_confirmation, 'manual_owner_confirmation_required');
    assert.equal('amount' in result.body, false);
    assert.equal(store.state.session.status, 'checkout_created');
    assert.equal(store.state.session.status === 'paid', false);
    assert.equal(store.state.claims.length, 1);
    assert.equal(store.state.claims[0].patch.status, 'checkout_created');
  }
});

test('all six cross-plan TEST URL swaps reject even with a recomputed URL hash and do not write', async () => {
  const { TEST_LINK_URLS } = await import('../../supabase/functions/_shared/revolut-test-links.mjs');
  const { resolveRevolutCheckout } = await checkoutModule();
  const planIds = Object.keys(TEST_LINK_URLS);

  for (const targetPlan of planIds) {
    for (const sourcePlan of planIds) {
      if (sourcePlan === targetPlan) continue;
      const env = await configuredTestEnv(targetPlan, TEST_LINK_URLS[sourcePlan]);
      const { result, store } = await createTestCheckout({ planId: targetPlan, env });
      assert.equal(result.status, 503, `${sourcePlan} -> ${targetPlan}`);
      assert.equal(result.body.error, 'checkout_not_configured');
      assert.equal('checkout_url' in result.body, false);
      assert.equal(store.state.claims.length, 0);
      assert.equal(store.state.writes.length, 0);

      const resolved = await resolveRevolutCheckout({
        plan: PLANS[targetPlan],
        getEnv: envFrom(env),
      });
      assert.equal(resolved, null, `${sourcePlan} -> ${targetPlan} resolver`);
    }
  }
});

test('unknown links fail closed without requiring an invented provider URL or a database write', async () => {
  const unknownUrl = 'https://example.invalid/not-a-checkout-link';
  const { validateLinkUrl } = await checkoutModule();
  assert.equal(await validateLinkUrl(unknownUrl), false);

  const env = await configuredTestEnv('monthly', unknownUrl);
  const { result, store } = await createTestCheckout({ planId: 'monthly', env });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'checkout_not_configured');
  assert.equal('checkout_url' in result.body, false);
  assert.equal(store.state.claims.length, 0);
  assert.equal(store.state.writes.length, 0);
});

test('a retired link is rejected when an optional local baseline supplies one', async (t) => {
  const baselinePath = '/tmp/payment-api-current.json';
  if (!fs.existsSync(baselinePath)) {
    t.skip('optional payment API baseline is not present');
    return;
  }
  const baseline = fs.readFileSync(baselinePath, 'utf8');
  const candidates = baseline.match(/https:\/\/[^\s"'\\]+/g) || [];
  const { RETIRED_LINK_DIGESTS, sha256, validateLinkUrl } = await checkoutModule();
  let retiredUrl;
  for (const candidate of candidates) {
    const clean = candidate.replace(/[),.;]+$/, '');
    try {
      const parsed = new URL(clean);
      const providerId = parsed.pathname.startsWith('/pay/')
        ? parsed.pathname.slice('/pay/'.length)
        : '';
      if (providerId && RETIRED_LINK_DIGESTS.includes(await sha256(providerId))) {
        retiredUrl = clean;
        break;
      }
    } catch {
      // Ignore unrelated URLs in the local baseline.
    }
  }
  if (!retiredUrl) {
    t.skip('baseline has no retired checkout link');
    return;
  }
  assert.equal(await validateLinkUrl(retiredUrl), false);
});

test('missing, malformed, nonallowlisted, and unsafe stored identities return 403 before resolving or claiming', async () => {
  const { TEST_LINK_URLS } = await import('../../supabase/functions/_shared/revolut-test-links.mjs');
  const cases = [
    ['missing identity', undefined, TEST_CUSTOMER_ID],
    ['malformed identity', 'not-a-telegram-id', TEST_CUSTOMER_ID],
    ['nonallowlisted identity', '9000000002', TEST_CUSTOMER_ID],
    ['unsafe numeric identity', Number.MAX_SAFE_INTEGER + 1, TEST_CUSTOMER_ID],
    ['zero identity', '0', TEST_CUSTOMER_ID],
    ['malformed allowlist', TEST_CUSTOMER_ID, `${TEST_CUSTOMER_ID},not-an-id`],
  ];

  for (const [label, telegramUserId, allowlist] of cases) {
    const env = await configuredTestEnv('monthly', TEST_LINK_URLS.monthly);
    env.REVOLUT_TEST_ALLOWED_TELEGRAM_IDS = allowlist;
    let resolverCalls = 0;
    const { result, store } = await createTestCheckout({
      planId: 'monthly',
      telegramUserId,
      env,
      resolver: async () => {
        resolverCalls += 1;
        throw new Error('resolver must not run for denied TEST identity');
      },
    });
    assert.equal(result.status, 403, label);
    assert.equal(result.body.error, 'test_checkout_forbidden', label);
    assert.equal('checkout_url' in result.body, false, label);
    assert.equal(store.state.claims.length, 0, `${label} claimed`);
    assert.equal(store.state.writes.length, 0, `${label} wrote`);
    assert.equal(resolverCalls, 0, `${label} resolved`);
  }
});

test('a repeat checkout is denied after the TEST allowlist is revoked', async () => {
  const { TEST_LINK_URLS } = await import('../../supabase/functions/_shared/revolut-test-links.mjs');
  const env = await configuredTestEnv('monthly', TEST_LINK_URLS.monthly);
  const first = await createTestCheckout({ planId: 'monthly', env });
  assert.equal(first.result.status, 200);
  assert.equal(first.store.state.claims.length, 1);

  const { createRevolutCheckout, resolveRevolutCheckout } = await checkoutModule();
  env.REVOLUT_TEST_ALLOWED_TELEGRAM_IDS = '';
  let resolverCalls = 0;
  const result = await createRevolutCheckout({
    token: TOKEN,
    store: first.store,
    plans: PLANS,
    getEnv: envFrom(env),
    now: () => NOW,
    resolveCheckout: async (args) => {
      resolverCalls += 1;
      return resolveRevolutCheckout(args);
    },
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'test_checkout_forbidden');
  assert.equal('checkout_url' in result.body, false);
  assert.equal(first.store.state.claims.length, 1);
  assert.equal(resolverCalls, 0);
});

test('production checkout remains available when the TEST allowlist is missing', async () => {
  const { resolveRevolutCheckout, sha256 } = await checkoutModule();
  const productionUrl = 'operator-attested-production-destination';
  const env = {
    REVOLUT_CHECKOUT_MODE: 'production',
    [configKey('production', 'monthly')]: JSON.stringify({
      mode: 'production',
      plan_id: 'monthly',
      url: productionUrl,
      currency: 'EUR',
      amount_cents: 5000,
      accept_multiple_payments: true,
      payment_limit: 'unlimited',
      status: 'active',
      expires_at: null,
      verified: true,
      verified_url_sha256: await sha256(productionUrl),
    }),
  };
  let resolverCalls = 0;
  const { result, store } = await createTestCheckout({
    env,
    resolver: async (args) => {
      resolverCalls += 1;
      return resolveRevolutCheckout({
        ...args,
        validateUrl: async (value) => value === productionUrl,
      });
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.checkout_mode, 'production');
  assert.equal(result.body.amount.amount_cents, 5000);
  assert.equal(result.body.checkout_provider, 'revolut_pro');
  assert.equal(resolverCalls, 1);
  assert.equal(store.state.claims.length, 1);
});

test('missing or false provider attestation fails closed for every supplied TEST link', async () => {
  const { TEST_LINK_URLS } = await import('../../supabase/functions/_shared/revolut-test-links.mjs');
  const { resolveRevolutCheckout } = await checkoutModule();
  for (const providerVerified of [undefined, false]) {
    const settings = await testSettings({ providerVerified, testerIds: TEST_CUSTOMER_ID });
    for (const planId of Object.keys(TEST_LINK_URLS)) {
      const result = await resolveRevolutCheckout({
        plan: PLANS[planId],
        getEnv: envFrom(settings),
      });
      assert.equal(result, null, `${String(providerVerified)} ${planId}`);
    }
  }
});

test('test settings are pure, contain exactly five TEST/mode keys, and require an allowlist', async () => {
  const { buildTestSettings } = await settingsModule();
  const settings = await buildTestSettings({
    providerVerified: true,
    testerIds: TEST_CUSTOMER_ID,
  });
  assert.deepEqual(Object.keys(settings).sort(), [
    'REVOLUT_CHECKOUT_MODE',
    'REVOLUT_TEST_ALLOWED_TELEGRAM_IDS',
    'REVOLUT_TEST_MONTHLY',
    'REVOLUT_TEST_SEVEN_DAY',
    'REVOLUT_TEST_YEARLY',
  ].sort());
  assert.equal(settings.REVOLUT_CHECKOUT_MODE, 'test');
  assert.equal(settings.REVOLUT_TEST_ALLOWED_TELEGRAM_IDS, TEST_CUSTOMER_ID);
  assert.equal(Object.keys(settings).some(key => key.includes('PRODUCTION')), false);
  assert.equal(JSON.parse(settings.REVOLUT_TEST_MONTHLY).amount_cents, 100);

  const secondSettings = await buildTestSettings({
    providerVerified: true,
    testerIds: TEST_CUSTOMER_ID,
  });
  assert.deepEqual(secondSettings, settings);
  for (const testerIds of ['', ' ', 'not-an-id', `${TEST_CUSTOMER_ID},not-an-id`]) {
    await assert.rejects(
      buildTestSettings({ providerVerified: true, testerIds }),
      /allowlist/,
    );
  }
});

test('internal configuration inspection reports only sanitized state for missing settings', async () => {
  const { inspectTestCheckoutConfiguration } = await checkoutModule();
  const result = await inspectTestCheckoutConfiguration({
    getEnv: () => undefined,
    plans: PLANS,
  });
  const expectedPlan = {
    configured: false,
    approved_url_matches: false,
    verification_hash_matches: false,
    ready: false,
  };
  assert.deepEqual(result, {
    mode: 'unconfigured',
    tester_allowlist_configured: false,
    plans: {
      seven_day: expectedPlan,
      monthly: expectedPlan,
      yearly: expectedPlan,
    },
  });
});

test('internal configuration inspection marks all three plans ready under inert verified TEST settings', async () => {
  const { inspectTestCheckoutConfiguration } = await checkoutModule();
  const settings = await testSettings({
    providerVerified: true,
    testerIds: TEST_CUSTOMER_ID,
  });
  const result = await inspectTestCheckoutConfiguration({
    getEnv: envFrom(settings),
    plans: PLANS,
  });
  assert.equal(result.mode, 'test');
  assert.equal(result.tester_allowlist_configured, true);
  for (const planId of Object.keys(PLANS)) {
    assert.deepEqual(result.plans[planId], {
      configured: true,
      approved_url_matches: true,
      verification_hash_matches: true,
      ready: true,
    });
  }
});

test('internal configuration inspection sanitizes unknown modes and detects wrong URL and hash', async () => {
  const { TEST_LINK_URLS } = await import('../../supabase/functions/_shared/revolut-test-links.mjs');
  const { inspectTestCheckoutConfiguration } = await checkoutModule();
  const settings = await testSettings({
    providerVerified: true,
    testerIds: TEST_CUSTOMER_ID,
  });
  settings.REVOLUT_CHECKOUT_MODE = 'TEST\nsecret-mode';
  const invalidMode = await inspectTestCheckoutConfiguration({
    getEnv: envFrom(settings),
    plans: PLANS,
  });
  assert.equal(invalidMode.mode, 'unconfigured');
  assert.equal(invalidMode.tester_allowlist_configured, true);
  assert.equal(Object.values(invalidMode.plans).every(plan => plan.ready === false), true);

  settings.REVOLUT_CHECKOUT_MODE = 'test';
  const monthly = JSON.parse(settings.REVOLUT_TEST_MONTHLY);
  settings.REVOLUT_TEST_MONTHLY = JSON.stringify({
    ...monthly,
    url: TEST_LINK_URLS.yearly,
    verified_url_sha256: monthly.verified_url_sha256,
    unknown_field: 'must-not-be-exposed',
  });
  const sevenDay = JSON.parse(settings.REVOLUT_TEST_SEVEN_DAY);
  settings.REVOLUT_TEST_SEVEN_DAY = JSON.stringify({
    ...sevenDay,
    verified_url_sha256: 'wrong-hash-must-not-be-exposed',
  });
  const result = await inspectTestCheckoutConfiguration({
    getEnv: envFrom(settings),
    plans: PLANS,
  });
  assert.equal(result.plans.monthly.configured, true);
  assert.equal(result.plans.monthly.approved_url_matches, false);
  assert.equal(result.plans.monthly.verification_hash_matches, false);
  assert.equal(result.plans.monthly.ready, false);
  assert.equal(result.plans.seven_day.approved_url_matches, true);
  assert.equal(result.plans.seven_day.verification_hash_matches, false);
  assert.equal(result.plans.seven_day.ready, false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /checkout\.revolut\.com|wrong-hash|must-not-be-exposed|secret-mode/);
  assert.deepEqual(Object.keys(result), ['mode', 'tester_allowlist_configured', 'plans']);
  for (const plan of Object.values(result.plans)) {
    assert.deepEqual(Object.keys(plan).sort(), [
      'approved_url_matches',
      'configured',
      'ready',
      'verification_hash_matches',
    ].sort());
  }
});

test('checkout configuration status API branch authenticates before inspecting', () => {
  const source = fs.readFileSync(API_SOURCE, 'utf8');
  const start = source.indexOf('segments[2] === "checkout-config-status"');
  const end = source.indexOf('if (segments[1] === "admin"', start);
  assert.ok(start >= 0 && end > start, 'internal checkout status route is present');
  const branch = source.slice(start, end);
  const secretIndex = branch.indexOf('getInternalSecret()');
  const bearerIndex = branch.indexOf('getBearerToken(req)');
  const compareIndex = branch.indexOf('safeEqual(token, secret)');
  const inspectIndex = branch.indexOf('inspectTestCheckoutConfiguration(');
  assert.ok(secretIndex >= 0);
  assert.ok(bearerIndex >= 0);
  assert.ok(compareIndex >= 0);
  assert.ok(inspectIndex >= 0);
  assert.ok(secretIndex < inspectIndex);
  assert.ok(bearerIndex < inspectIndex);
  assert.ok(compareIndex < inspectIndex);
  assert.match(branch, /if \(!token \|\| !safeEqual\(token, secret\)\)/);
});