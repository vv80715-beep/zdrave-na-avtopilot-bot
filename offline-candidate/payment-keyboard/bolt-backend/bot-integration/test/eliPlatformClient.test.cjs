'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EliPlatformClient,
  EliPlatformError,
  normalizeEntitlementResponse,
} = require('../eliPlatformClient.cjs');

const SECRET = 's'.repeat(40);
const SESSION_TOKEN = 'A'.repeat(43);

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function entitlementPayload(overrides = {}) {
  return {
    api_version: 1,
    checked_at: '2026-08-19T09:05:00.000Z',
    entitlement: {
      telegram_user_id: '8934490753',
      active: true,
      plan_id: 'monthly',
      plan: { id: 'monthly', name: '1 месец с Ели' },
      status: 'active',
      billing_status: 'active',
      modes: ['text', 'voice', 'avatar', 'community'],
      avatar_minutes_per_month: 30,
      starts_at: '2026-08-19T09:00:00.000Z',
      current_period_start: '2026-08-19T09:00:00.000Z',
      current_period_end: '2026-09-19T09:00:00.000Z',
      expires_at: '2026-09-19T09:00:00.000Z',
      cancel_at_period_end: false,
      ...overrides,
    },
  };
}

test('production client requires HTTPS and a strong internal secret', () => {
  assert.throws(
    () => new EliPlatformClient({ baseUrl: 'http://eli.example', internalSecret: SECRET, production: true }),
    (error) => error instanceof EliPlatformError && error.code === 'https_required',
  );
  assert.throws(
    () => new EliPlatformClient({ baseUrl: 'https://eli.example', internalSecret: 'short', production: true }),
    (error) => error instanceof EliPlatformError && error.code === 'weak_internal_secret',
  );
});

test('createPurchaseSession sends only trusted internal fields and returns an opaque same-origin URL', async () => {
  let captured;
  const client = new EliPlatformClient({
    baseUrl: 'https://eli.example',
    internalSecret: SECRET,
    production: true,
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return jsonResponse({
        api_version: 1,
        purchase_url: `https://eli.example/confirm-plan.html?session=${SESSION_TOKEN}`,
        expires_at: '2026-08-19T10:00:00.000Z',
        plan: { id: 'monthly', name: '1 месец с Ели' },
      }, 201);
    },
  });

  const result = await client.createPurchaseSession({ telegramUserId: '8934490753', planId: 'monthly' });
  assert.equal(captured.url, 'https://eli.example/api/internal/purchase-sessions');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.authorization, `Bearer ${SECRET}`);
  assert.deepEqual(JSON.parse(captured.options.body), {
    telegram_user_id: '8934490753',
    plan_id: 'monthly',
  });
  assert.equal(result.purchaseUrl.includes('8934490753'), false);
  assert.equal(result.plan.id, 'monthly');
});

test('invalid plan is rejected before a network request', async () => {
  let calls = 0;
  const client = new EliPlatformClient({
    baseUrl: 'https://eli.example',
    internalSecret: SECRET,
    production: true,
    fetchImpl: async () => { calls += 1; return jsonResponse({}); },
  });
  await assert.rejects(
    client.createPurchaseSession({ telegramUserId: '8934490753', planId: 'vip' }),
    (error) => error instanceof EliPlatformError && error.code === 'invalid_plan',
  );
  assert.equal(calls, 0);
});

test('purchase response rejects API version mismatch and cross-origin URLs', async () => {
  const versionClient = new EliPlatformClient({
    baseUrl: 'https://eli.example', internalSecret: SECRET, production: true,
    fetchImpl: async () => jsonResponse({
      api_version: 2,
      purchase_url: `https://eli.example/confirm-plan.html?session=${SESSION_TOKEN}`,
      expires_at: '2026-08-19T10:00:00.000Z',
      plan: { id: 'monthly' },
    }),
  });
  await assert.rejects(
    versionClient.createPurchaseSession({ telegramUserId: '8934490753', planId: 'monthly' }),
    (error) => error.code === 'api_version_mismatch',
  );

  const crossOriginClient = new EliPlatformClient({
    baseUrl: 'https://eli.example', internalSecret: SECRET, production: true,
    fetchImpl: async () => jsonResponse({
      api_version: 1,
      purchase_url: `https://evil.example/confirm-plan.html?session=${SESSION_TOKEN}`,
      expires_at: '2026-08-19T10:00:00.000Z',
      plan: { id: 'monthly' },
    }),
  });
  await assert.rejects(
    crossOriginClient.createPurchaseSession({ telegramUserId: '8934490753', planId: 'monthly' }),
    (error) => error.code === 'invalid_purchase_url',
  );
});

test('production purchase session accepts cross-origin purchase URL when purchaseUrlOrigin is configured', async () => {
  const client = new EliPlatformClient({
    baseUrl: 'https://api.example',
    internalSecret: SECRET,
    purchaseUrlOrigin: 'https://static.example',
    production: true,
    fetchImpl: async () => jsonResponse({
      api_version: 1,
      purchase_url: `https://static.example/confirm-plan.html?session=${SESSION_TOKEN}`,
      expires_at: '2026-08-19T10:00:00.000Z',
      plan: { id: 'seven_day', name: '7 дни с Ели' },
    }, 201),
  });

  const result = await client.createPurchaseSession({ telegramUserId: '8934490753', planId: 'seven_day' });
  assert.equal(result.purchaseUrl, `https://static.example/confirm-plan.html?session=${SESSION_TOKEN}`);
  assert.equal(result.plan.id, 'seven_day');
  assert.equal(result.plan.name, '7 дни с Ели');
});

test('production purchase session rejects cross-origin URL when purchaseUrlOrigin is not configured', async () => {
  const client = new EliPlatformClient({
    baseUrl: 'https://api.example',
    internalSecret: SECRET,
    production: true,
    fetchImpl: async () => jsonResponse({
      api_version: 1,
      purchase_url: `https://static.example/confirm-plan.html?session=${SESSION_TOKEN}`,
      expires_at: '2026-08-19T10:00:00.000Z',
      plan: { id: 'seven_day', name: '7 дни с Ели' },
    }, 201),
  });

  await assert.rejects(
    client.createPurchaseSession({ telegramUserId: '8934490753', planId: 'seven_day' }),
    (error) => error.code === 'invalid_purchase_url',
  );
});

test('production purchase response schema matches exact bot contract', async () => {
  const client = new EliPlatformClient({
    baseUrl: 'https://api.example',
    internalSecret: SECRET,
    purchaseUrlOrigin: 'https://static.example',
    production: true,
    fetchImpl: async () => jsonResponse({
      api_version: 1,
      purchase_url: `https://static.example/confirm-plan.html?session=${SESSION_TOKEN}`,
      expires_at: '2026-08-24T13:06:54.000Z',
      plan: { id: 'seven_day', name: '7 дни с Ели' },
    }, 201),
  });

  const result = await client.createPurchaseSession({ telegramUserId: '8934490753', planId: 'seven_day' });
  assert.equal(typeof result.purchaseUrl, 'string');
  assert.ok(result.purchaseUrl.startsWith('https://'));
  assert.ok(result.purchaseUrl.includes('/confirm-plan.html?session='));
  assert.equal(typeof result.expiresAt.toISOString(), 'string');
  assert.equal(result.plan.id, 'seven_day');
  assert.equal(typeof result.plan.name, 'string');
  assert.ok(result.plan.name.length > 0);
});

test('getEntitlement validates owner, modes and active period', async () => {
  const client = new EliPlatformClient({
    baseUrl: 'https://eli.example', internalSecret: SECRET, production: true,
    fetchImpl: async () => jsonResponse(entitlementPayload()),
  });
  const entitlement = await client.getEntitlement('8934490753');
  assert.equal(entitlement.exists, true);
  assert.equal(entitlement.active, true);
  assert.equal(entitlement.planId, 'monthly');
  assert.deepEqual(entitlement.modes, ['text', 'voice', 'avatar', 'community']);
  assert.equal(entitlement.avatarMinutesPerMonth, 30);
});

test('no backend entitlement is represented explicitly without granting paid access', () => {
  const value = normalizeEntitlementResponse({
    api_version: 1,
    checked_at: '2026-08-19T09:05:00.000Z',
    entitlement: null,
  }, { requestedTelegramUserId: '8934490753' });
  assert.equal(value.exists, false);
  assert.equal(value.active, false);
  assert.equal(value.planId, null);
  assert.deepEqual(value.modes, []);
});

test('getEntitlement fails closed on owner mismatch and invalid inactive modes', async () => {
  const ownerMismatch = new EliPlatformClient({
    baseUrl: 'https://eli.example', internalSecret: SECRET, production: true,
    fetchImpl: async () => jsonResponse(entitlementPayload({ telegram_user_id: '9999999999' })),
  });
  await assert.rejects(
    ownerMismatch.getEntitlement('8934490753'),
    (error) => error.code === 'telegram_user_mismatch',
  );

  const inactiveModes = new EliPlatformClient({
    baseUrl: 'https://eli.example', internalSecret: SECRET, production: true,
    fetchImpl: async () => jsonResponse(entitlementPayload({ active: false, modes: ['text'], avatar_minutes_per_month: 0 })),
  });
  await assert.rejects(
    inactiveModes.getEntitlement('8934490753'),
    (error) => error.code === 'invalid_entitlement_modes',
  );
});

test('entitlement GET retries once on a retryable platform error', async () => {
  let calls = 0;
  const client = new EliPlatformClient({
    baseUrl: 'https://eli.example', internalSecret: SECRET, production: true,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: 'temporary', message: 'temporary' }, 503)
        : jsonResponse(entitlementPayload());
    },
  });
  const entitlement = await client.getEntitlement('8934490753');
  assert.equal(entitlement.active, true);
  assert.equal(calls, 2);
});

test('platform timeout is retryable and does not expose the internal secret', async () => {
  const client = new EliPlatformClient({
    baseUrl: 'https://eli.example',
    internalSecret: SECRET,
    production: true,
    timeoutMs: 500,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      const abort = () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }),
  });

  await assert.rejects(
    client.getEntitlement('8934490753'),
    (error) => (
      error instanceof EliPlatformError
      && error.code === 'platform_timeout'
      && error.retryable === true
      && !error.message.includes(SECRET)
    ),
  );
});

test('oversized API response is rejected before contract parsing', async () => {
  const client = new EliPlatformClient({
    baseUrl: 'https://eli.example',
    internalSecret: SECRET,
    production: true,
    maxResponseBytes: 1024,
    fetchImpl: async () => new Response('x'.repeat(2048), {
      status: 200,
      headers: { 'content-length': '2048' },
    }),
  });
  await assert.rejects(
    client.getEntitlement('8934490753'),
    (error) => error.code === 'response_too_large',
  );
});
