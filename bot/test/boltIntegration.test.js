// Offline contract and regression tests for the Bolt purchase/entitlement
// bridge. Native fetch is always mocked; no Bolt, Stripe, TTS, or HeyGen calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-bolt-test-'));
process.env.ENTITLEMENTS_PATH = path.join(tmp, 'entitlements.json');
process.env.AVATAR_MODE_PATH = path.join(tmp, 'avatar-mode.json');
process.env.AVATAR_CLAIMS_PATH = path.join(tmp, 'avatar-claims.json');
process.env.HEYGEN_API_KEY = 'offline-test-key';
process.env.HEYGEN_AVATAR_ID = 'offline-test-avatar';
process.env.HEYGEN_VOICE_ID = 'offline-test-voice';
const TEST_SECRET = 's'.repeat(40);

const {
  EliPlatformClient,
  BoltPlatformError,
} = require('../boltPlatformClient');
const {
  PLAN_OPTIONS,
  PLANS_TEXT,
  planKeyboard,
} = require('../planLinks');
const plans = require('../commands/plans');
const {
  resolveEntitlementStatus,
  verifyPaidMode,
  clearEntitlementCache,
  _setPlatformClientForTests,
} = require('../entitlementResolver');
const {
  ensureUser,
  activatePlan,
  DAY_MS,
} = require('../entitlements');
const { checkFeatureCredits } = require('../credits');
const { checkAvatarCredits, sendAvatarReply } = require('../avatarService');
const { sendVoiceReply } = require('../voiceReplyService');

function jsonResponse(data, status = 200) {
  const text = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-length'
          ? String(Buffer.byteLength(text, 'utf8'))
          : null;
      },
    },
    text: async () => text,
    json: async () => data,
  };
}

function activeEntitlement(id, planId, modes) {
  const startsAt = new Date(Date.now() - DAY_MS);
  const periodStart = new Date(Date.now() - DAY_MS);
  const periodEnd = new Date(Date.now() + 10 * DAY_MS);
  const normalizedModes = modes || (
    planId === 'seven_day'
      ? ['text', 'voice', 'community']
      : ['text', 'voice', 'avatar', 'community']
  );
  return {
    telegram_user_id: String(id),
    active: true,
    plan_id: planId,
    plan: {
      id: planId,
      name: planId === 'seven_day'
        ? '7 дни с Ели'
        : planId === 'monthly'
          ? '1 месец с Ели'
          : '1 година с Ели',
    },
    status: 'active',
    billing_status: planId === 'seven_day' ? 'paid' : 'active',
    modes: normalizedModes,
    avatar_minutes_per_month: normalizedModes.includes('avatar')
      ? (planId === 'yearly' ? 20 : 30)
      : 0,
    starts_at: startsAt.toISOString(),
    current_period_start: periodStart.toISOString(),
    current_period_end: periodEnd.toISOString(),
    expires_at: periodEnd.toISOString(),
    cancel_at_period_end: false,
  };
}

function fakeCtx(id, text = '') {
  const sent = { replies: [], callbackAnswers: 0, actions: [], videos: [] };
  return {
    from: { id, first_name: 'Тест' },
    chat: { id, type: 'private' },
    message: { text },
    update: { update_id: Number(id) + 500000 },
    sent,
    answerCbQuery: async () => {
      sent.callbackAnswers += 1;
    },
    reply: async (message, extra) => {
      sent.replies.push({ message, extra });
    },
    sendChatAction: async (action) => {
      sent.actions.push(action);
    },
    replyWithVoice: async () => {
      throw new Error('paid provider path must not be reached');
    },
    replyWithVideo: async (video) => {
      sent.videos.push(video);
    },
  };
}

function fakeBot() {
  return {
    commands: new Map(),
    actions: new Map(),
    command(name, handler) {
      this.commands.set(name, handler);
    },
    action(name, handler) {
      this.actions.set(name, handler);
    },
  };
}

test.after(() => {
  _setPlatformClientForTests(null);
  for (const file of fs.readdirSync(tmp)) {
    try { fs.unlinkSync(path.join(tmp, file)); } catch (_) {}
  }
  try { fs.rmdirSync(tmp); } catch (_) {}
});

test('Bolt client sends exact Bearer auth, identity, plan, and uses secure response URL', async () => {
  const requests = [];
  const sessionToken = 'A'.repeat(43);
  const client = new EliPlatformClient({
    baseUrl: 'https://zdrave-na-avtopilot-dkr6.bolt.host',
    allowUnapprovedEndpointForTests: true,
    secret: TEST_SECRET,
    purchaseUrlOrigin: 'https://checkout.example',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const body = JSON.parse(options.body);
      return jsonResponse({
        api_version: 1,
        purchase_url:
          `https://checkout.example/confirm-plan.html?session=${sessionToken}`,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        plan: { id: body.plan_id, name: body.plan_id },
      });
    },
  });

  for (const planId of ['seven_day', 'monthly', 'yearly']) {
    const result = await client.createPurchaseSession(123456, planId);
    assert.equal(
      result.purchase_url,
      `https://checkout.example/confirm-plan.html?session=${sessionToken}`
    );
  }
  assert.equal(requests.length, 3);
  for (let i = 0; i < requests.length; i += 1) {
    const { url, options } = requests[i];
    assert.equal(
      url,
      'https://zdrave-na-avtopilot-dkr6.bolt.host/internal/purchase-sessions'
    );
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${TEST_SECRET}`);
    assert.deepEqual(JSON.parse(options.body), {
      telegram_user_id: '123456',
      plan_id: ['seven_day', 'monthly', 'yearly'][i],
    });
  }
});

test('Bolt client rejects injected plans before fetch', async () => {
  let calls = 0;
  const client = new EliPlatformClient({
    baseUrl: 'https://platform.example',
    allowUnapprovedEndpointForTests: true,
    secret: TEST_SECRET,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });
  await assert.rejects(
    client.createPurchaseSession('123456', 'monthly&telegram_user_id=999'),
    (err) => err instanceof BoltPlatformError && err.code === 'invalid_plan'
  );
  assert.equal(calls, 0);
});

test('entitlement lookup uses exact path/auth and rejects Telegram identity mismatch', async () => {
  let captured;
  const client = new EliPlatformClient({
    baseUrl: 'https://platform.example',
    allowUnapprovedEndpointForTests: true,
    secret: TEST_SECRET,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return jsonResponse({
        api_version: 1,
        checked_at: new Date().toISOString(),
        entitlement: activeEntitlement('999999', 'monthly'),
      });
    },
  });
  await assert.rejects(
    client.getEntitlement('123456'),
    (err) =>
      err instanceof BoltPlatformError &&
      err.code === 'telegram_user_id_mismatch'
  );
  assert.equal(
    captured.url,
    'https://platform.example/internal/entitlements/123456'
  );
  assert.equal(captured.options.method, 'GET');
  assert.equal(captured.options.headers.Authorization, `Bearer ${TEST_SECRET}`);
});

test('runtime endpoint must target the approved production Supabase function', () => {
  assert.doesNotThrow(() => new EliPlatformClient({
    baseUrl:
      'https://aoaylzncorwakxcactox.supabase.co/functions/v1/api',
    secret: TEST_SECRET,
    purchaseUrlOrigin: 'https://checkout.example',
  }));
  for (const baseUrl of [
    'https://aighgpkrexvhyvfohuxp.supabase.co/functions/v1/api',
    'https://aoaylzncorwakxcactox.supabase.co/functions/v1/other',
    'https://aoaylzncorwakxcactox.supabase.co:444/functions/v1/api',
  ]) {
    assert.throws(
      () => new EliPlatformClient({
        baseUrl,
        secret: TEST_SECRET,
        purchaseUrlOrigin: 'https://checkout.example',
      }),
      (err) =>
        err instanceof BoltPlatformError &&
        err.code === 'unapproved_platform_endpoint'
    );
  }
});

test('unapproved endpoint escape hatch is available only in exact test environment', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  try {
    for (const nodeEnv of ['TEST', ' test ', 'production']) {
      process.env.NODE_ENV = nodeEnv;
      assert.throws(
        () => new EliPlatformClient({
          baseUrl: 'https://evil.example/functions/v1/api',
          secret: TEST_SECRET,
          purchaseUrlOrigin: 'https://checkout.example',
          allowUnapprovedEndpointForTests: true,
        }),
        (err) =>
          err instanceof BoltPlatformError &&
          err.code === 'unapproved_platform_endpoint'
      );
    }
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

test('runtime endpoint cannot be redirected by environment configuration', () => {
  const originalBaseUrl = process.env.ELI_PLATFORM_BASE_URL;
  try {
    process.env.ELI_PLATFORM_BASE_URL =
      'https://evil.example/functions/v1/api';
    const client = new EliPlatformClient({
      secret: TEST_SECRET,
      purchaseUrlOrigin: 'https://checkout.example',
    });
    assert.equal(
      client.baseUrl,
      'https://aoaylzncorwakxcactox.supabase.co/functions/v1/api'
    );
  } finally {
    if (originalBaseUrl === undefined) {
      delete process.env.ELI_PLATFORM_BASE_URL;
    } else {
      process.env.ELI_PLATFORM_BASE_URL = originalBaseUrl;
    }
  }
});

test('constructor rejects missing, placeholder, and weak internal API secrets', () => {
  const invalidSecrets = [
    { value: null, code: 'missing_internal_secret' },
    { value: '', code: 'missing_internal_secret' },
    {
      value: 'replace-with-at-least-32-random-characters',
      code: 'placeholder_internal_secret',
    },
    { value: 's'.repeat(31), code: 'weak_internal_secret' },
  ];
  for (const { value, code } of invalidSecrets) {
    assert.throws(
      () => new EliPlatformClient({
        secret: value,
        purchaseUrlOrigin: 'https://checkout.example',
      }),
      (err) => err instanceof BoltPlatformError && err.code === code
    );
  }
});

test('entitlement GET retries exactly once after retryable first failures', async () => {
  const firstFailures = [
    () => { throw new Error('offline network failure'); },
    () => {
      const error = new Error('offline timeout');
      error.name = 'AbortError';
      throw error;
    },
    () => jsonResponse({ error: 'rate_limited' }, 429),
    () => jsonResponse({ error: 'temporary' }, 503),
  ];

  for (const firstFailure of firstFailures) {
    let calls = 0;
    const client = new EliPlatformClient({
      baseUrl: 'https://platform.example',
      allowUnapprovedEndpointForTests: true,
      secret: TEST_SECRET,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return firstFailure();
        return jsonResponse({
          api_version: 1,
          checked_at: new Date().toISOString(),
          entitlement: null,
        });
      },
    });
    const result = await client.getEntitlement('123456');
    assert.equal(result.entitlement, null);
    assert.equal(calls, 2);
  }
});

test('entitlement GET stops after the single bounded retry', async () => {
  let calls = 0;
  const client = new EliPlatformClient({
    baseUrl: 'https://platform.example',
    allowUnapprovedEndpointForTests: true,
    secret: TEST_SECRET,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: 'temporary' }, 503);
    },
  });
  await assert.rejects(
    client.getEntitlement('123456'),
    (err) =>
      err instanceof BoltPlatformError &&
      err.code === 'http_error' &&
      err.status === 503
  );
  assert.equal(calls, 2);
});

test('entitlement GET never retries auth, other 4xx, schema, or invalid JSON failures', async () => {
  const cases = [
    () => jsonResponse({ error: 'unauthorized' }, 401),
    () => jsonResponse({ error: 'invalid_user' }, 400),
    () => jsonResponse({
      api_version: 1,
      checked_at: new Date().toISOString(),
      entitlement: { unexpected: true },
    }),
    () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{not-json',
    }),
  ];

  for (const responseFactory of cases) {
    let calls = 0;
    const client = new EliPlatformClient({
      baseUrl: 'https://platform.example',
      allowUnapprovedEndpointForTests: true,
      secret: TEST_SECRET,
      fetchImpl: async () => {
        calls += 1;
        return responseFactory();
      },
    });
    await assert.rejects(client.getEntitlement('123456'));
    assert.equal(calls, 1);
  }
});

test('purchase-session POST is never retried for network, 429, or 5xx failures', async () => {
  const failures = [
    () => { throw new Error('offline network failure'); },
    () => jsonResponse({ error: 'rate_limited' }, 429),
    () => jsonResponse({ error: 'temporary' }, 503),
  ];
  for (const failure of failures) {
    let calls = 0;
    const client = new EliPlatformClient({
      baseUrl: 'https://platform.example',
      allowUnapprovedEndpointForTests: true,
      secret: TEST_SECRET,
      purchaseUrlOrigin: 'https://checkout.example',
      fetchImpl: async () => {
        calls += 1;
        return failure();
      },
    });
    await assert.rejects(
      client.createPurchaseSession('123456', 'monthly')
    );
    assert.equal(calls, 1);
  }
});

test('request errors and diagnostics never expose the internal API secret', async () => {
  const client = new EliPlatformClient({
    baseUrl: 'https://platform.example',
    allowUnapprovedEndpointForTests: true,
    secret: TEST_SECRET,
    fetchImpl: async () => {
      throw new Error(`provider echoed ${TEST_SECRET}`);
    },
  });
  let caught;
  try {
    await client.getEntitlement('123456');
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof BoltPlatformError);
  const rendered = JSON.stringify({
    message: caught.message,
    stack: caught.stack,
    diagnostic: plans.purchaseFailureDiagnostic(caught),
  });
  assert.equal(rendered.includes(TEST_SECRET), false);
});

test('purchase response accepts only the trusted confirmation destination and opaque token', async () => {
  const valid = {
    api_version: 1,
    purchase_url:
      `https://checkout.example/confirm-plan.html?session=${'A'.repeat(43)}`,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    plan: { id: 'monthly', name: '1 месец с Ели' },
  };
  const variants = [
    { ...valid, purchase_url: `https://evil.example/confirm-plan.html?session=${'A'.repeat(43)}` },
    { ...valid, purchase_url: `https://checkout.example/monthly.html?session=${'A'.repeat(43)}` },
    { ...valid, purchase_url: 'https://checkout.example/confirm-plan.html?session=short' },
    { ...valid, purchase_url: `https://checkout.example/confirm-plan.html?session=${'A'.repeat(43)}&telegram_user_id=123456` },
    { ...valid, purchase_url: `https://checkout.example/confirm-plan.html?session=${'A'.repeat(43)}#fragment` },
  ];

  for (const payload of variants) {
    const client = new EliPlatformClient({
      baseUrl: 'https://platform.example',
      allowUnapprovedEndpointForTests: true,
      secret: TEST_SECRET,
      purchaseUrlOrigin: 'https://checkout.example',
      fetchImpl: async () => jsonResponse(payload, 201),
    });
    await assert.rejects(
      client.createPurchaseSession('123456', 'monthly'),
      (err) =>
        err instanceof BoltPlatformError &&
        err.code === 'invalid_purchase_response'
    );
  }
});

test('backend response body is rejected before parsing when it exceeds the configured limit', async () => {
  let calls = 0;
  const client = new EliPlatformClient({
    baseUrl: 'https://platform.example',
    allowUnapprovedEndpointForTests: true,
    secret: TEST_SECRET,
    purchaseUrlOrigin: 'https://checkout.example',
    maxResponseBytes: 1024,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => '2048' },
        text: async () => assert.fail('oversized body must not be read'),
      };
    },
  });
  await assert.rejects(
    client.getEntitlement('123456'),
    (err) =>
      err instanceof BoltPlatformError &&
      err.code === 'response_too_large'
  );
  assert.equal(calls, 1);
});

test('strict entitlement contract rejects unknown modes, invalid periods, and inconsistent avatar allowance', async () => {
  const id = '123456';
  const checkedAt = new Date().toISOString();
  const validEntitlement = activeEntitlement(
    id,
    'monthly',
    ['text', 'voice', 'avatar', 'community']
  );
  const malformed = [
    { ...validEntitlement, modes: ['text', 'voice', 'telepathy'] },
    { ...validEntitlement, modes: ['text', 'voice', 'voice'] },
    { ...validEntitlement, plan: { id: 'yearly', name: 'Wrong plan' } },
    { ...validEntitlement, active: 'true' },
    { ...validEntitlement, avatar_minutes_per_month: 0.5 },
    {
      ...validEntitlement,
      modes: ['text', 'voice', 'community'],
      avatar_minutes_per_month: 30,
    },
    {
      ...validEntitlement,
      current_period_end: validEntitlement.current_period_start,
    },
    { ...validEntitlement, cancel_at_period_end: 'false' },
  ];

  for (const entitlement of malformed) {
    const client = new EliPlatformClient({
      baseUrl: 'https://platform.example',
      allowUnapprovedEndpointForTests: true,
      secret: TEST_SECRET,
      fetchImpl: async () => jsonResponse({
        api_version: 1,
        checked_at: checkedAt,
        entitlement,
      }),
    });
    await assert.rejects(
      client.getEntitlement(id),
      (err) => err instanceof BoltPlatformError
    );
  }
});

test('/plans and show_plans display all canonical plans', async () => {
  const bot = fakeBot();
  plans.register(bot, {
    client: { createPurchaseSession: async () => assert.fail('not a purchase') },
  });
  assert.ok(bot.commands.has('plans'));
  assert.ok(bot.actions.has('show_plans'));
  for (const callback of ['buy:seven_day', 'buy:monthly', 'buy:yearly']) {
    assert.ok(bot.actions.has(callback));
  }
  assert.deepEqual(
    PLAN_OPTIONS.map((p) => p.callback),
    ['buy:seven_day', 'buy:monthly', 'buy:yearly']
  );
  assert.deepEqual(
    planKeyboard().reply_markup.inline_keyboard.map(
      ([button]) => button.callback_data
    ),
    ['buy:seven_day', 'buy:monthly', 'buy:yearly']
  );
  for (const required of [
    '7 days — €15',
    'Text + Voice + Community',
    'No Avatar',
    'Monthly — €50',
    '30 Avatar minutes/month',
    'Yearly — €360',
    '20 Avatar minutes/month',
  ]) {
    assert.ok(PLANS_TEXT.includes(required), required);
  }

  const commandCtx = fakeCtx(101);
  await bot.commands.get('plans')(commandCtx);
  assert.equal(commandCtx.sent.replies[0].message, PLANS_TEXT);

  const callbackCtx = fakeCtx(101);
  await bot.actions.get('show_plans')(callbackCtx);
  assert.equal(callbackCtx.sent.callbackAnswers, 1);
  assert.equal(callbackCtx.sent.replies[0].message, PLANS_TEXT);
});

test('purchase callbacks use ctx.from.id, use returned URL, and never alter local entitlement', async () => {
  const calls = [];
  const returnedPlanNames = {
    seven_day: '7 дни с Ели',
    monthly: '1 месец с Ели',
    yearly: '1 година с Ели',
  };
  const bot = fakeBot();
  plans.register(bot, {
    client: {
      createPurchaseSession: async (id, planId) => {
        calls.push({ id, planId });
        return {
          purchase_url: `https://secure.example/${planId}/${id}`,
          plan: { id: planId, name: returnedPlanNames[planId] },
        };
      },
    },
  });
  const localBefore = ensureUser(202, Date.now() - DAY_MS);
  const before = JSON.stringify(localBefore);

  for (const planId of ['seven_day', 'monthly', 'yearly']) {
    const ctx = fakeCtx(202);
    // User-controlled message text is deliberately a different identity.
    ctx.message.text = '/buy 999999';
    await bot.actions.get(`buy:${planId}`)(ctx);
    const button =
      ctx.sent.replies[0].extra.reply_markup.inline_keyboard[0][0];
    assert.equal(button.text, 'Confirm payment');
    assert.equal(ctx.sent.replies[0].extra.reply_markup.inline_keyboard.length, 1);
    assert.equal(ctx.sent.replies[0].extra.reply_markup.inline_keyboard[0].length, 1);
    assert.equal(button.url, `https://secure.example/${planId}/202`);
    assert.equal(
      ctx.sent.replies[0].message,
      `Сигурният ти линк за план „${returnedPlanNames[planId]}" е готов:`
    );
  }
  assert.deepEqual(calls, [
    { id: '202', planId: 'seven_day' },
    { id: '202', planId: 'monthly' },
    { id: '202', planId: 'yearly' },
  ]);
  assert.equal(JSON.stringify(ensureUser(202)), before);
  assert.equal(bot.actions.has('buy:evil_plan'), false);
});

test('group purchase callbacks cannot bind group chat to a Telegram user', async () => {
  let calls = 0;
  const bot = fakeBot();
  plans.register(bot, {
    client: { createPurchaseSession: async () => { calls += 1; } },
  });
  const ctx = fakeCtx(202);
  ctx.chat = { id: -100202, type: 'supergroup' };
  await bot.actions.get('buy:monthly')(ctx);
  assert.equal(ctx.sent.callbackAnswers, 1);
  assert.equal(calls, 0);
  assert.equal(ctx.sent.replies.length, 1);
  assert.equal(ctx.sent.replies[0].message, plans.PRIVATE_PURCHASE_MESSAGE);
});

test('purchase failures log only sanitized metadata and retain the Bulgarian fallback', async () => {
  const bot = fakeBot();
  plans.register(bot, {
    client: {
      createPurchaseSession: async () => {
        throw new BoltPlatformError('http_error', 502);
      },
    },
  });
  const logs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => logs.push(args);
  try {
    const ctx = fakeCtx(211);
    await bot.actions.get('buy:seven_day')(ctx);
    assert.equal(ctx.sent.replies[0].message, plans.PURCHASE_ERROR_MESSAGE);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(logs, [[
    'Bolt purchase-session request failed',
    {
      status: 502,
      code: 'http_error',
      errorClass: 'BoltPlatformError',
      category: 'http',
    },
  ]]);
  assert.deepEqual(
    plans.purchaseFailureDiagnostic(new BoltPlatformError('timeout')),
    {
      status: null,
      code: 'timeout',
      errorClass: 'BoltPlatformError',
      category: 'network',
    }
  );
  assert.deepEqual(plans.purchaseFailureDiagnostic(new Error('sensitive detail')), {
    status: null,
    code: null,
    errorClass: 'Error',
    category: 'unknown',
  });
});

test('plan handler registration is idempotent', () => {
  const bot = fakeBot();
  const client = { createPurchaseSession: async () => ({}) };
  assert.equal(plans.register(bot, { client }), true);
  const counts = { commands: bot.commands.size, actions: bot.actions.size };
  assert.equal(plans.register(bot, { client }), false);
  assert.deepEqual(
    { commands: bot.commands.size, actions: bot.actions.size },
    counts
  );
});

test('normal start payloads remain untouched; payment_complete forces refresh', async () => {
  assert.equal(plans.startPayload('/start'), null);
  assert.equal(plans.startPayload('/start ordinary_payload'), 'ordinary_payload');
  assert.equal(plans.startPayload('/start payment_complete'), 'payment_complete');

  const calls = [];
  const ctx = fakeCtx(303, '/start payment_complete');
  const status = await plans.refreshPaymentComplete(ctx, {
    clearCache: (id) => calls.push({ clear: id }),
    resolveStatus: async (id, opts) => {
      calls.push({ resolve: id, opts });
      return {
        active: true,
        backendVerified: true,
        state: 'paid',
        plan: 'monthly',
        allowedModes: ['text', 'voice', 'avatar'],
        canChat: true,
      };
    },
  });
  assert.equal(status.plan, 'monthly');
  assert.deepEqual(calls, [
    { clear: '303' },
    { resolve: '303', opts: { forceRefresh: true } },
  ]);
  assert.ok(ctx.sent.replies[0].message.includes('Месечен'));

  // Start and help are pre-stage escape commands, not post-stage welcome menus.
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(source.indexOf('startCommands.register(bot,') < source.indexOf('bot.use(stage.middleware())'));
  assert.equal(source.includes("ctx.reply('💳 Планове и абонамент'"), false);
});

test('verified monthly backend entitlement overrides local Trial and allows Avatar', async () => {
  const id = 401;
  ensureUser(id);
  _setPlatformClientForTests({
    getEntitlement: async () => ({
      entitlement: activeEntitlement(id, 'monthly', [
        'text',
        'voice',
        'avatar',
      ]),
    }),
  });
  const status = await resolveEntitlementStatus(id);
  assert.equal(status.state, 'paid');
  assert.equal(status.plan, 'monthly');
  assert.deepEqual(status.allowedModes, ['text', 'voice', 'avatar']);
  assert.equal((await checkAvatarCredits(id)).allowed, true);
});

test('verified seven_day entitlement allows Voice but blocks Avatar', async () => {
  const id = 402;
  ensureUser(id);
  _setPlatformClientForTests({
    getEntitlement: async () => ({
      entitlement: activeEntitlement(id, 'seven_day', [
        'text',
        'voice',
      ]),
    }),
  });
  assert.equal((await checkFeatureCredits(id, 'voice')).allowed, true);
  assert.equal((await checkFeatureCredits(id, 'avatar')).allowed, false);
});

test('expired paid plan cannot create a second Trial', async () => {
  const id = 403;
  ensureUser(id, Date.now() - 30 * DAY_MS);
  _setPlatformClientForTests({
    getEntitlement: async () => ({
      entitlement: {
        telegram_user_id: String(id),
        plan_id: 'monthly',
        status: 'expired',
        expires_at: new Date(Date.now() - DAY_MS).toISOString(),
      },
    }),
  });
  const status = await resolveEntitlementStatus(id);
  assert.equal(status.state, 'paid_expired');
  assert.equal(status.canChat, false);
  assert.deepEqual(status.allowedModes, []);
});

test('backend failure keeps an active local Trial text-only and blocks Voice/Avatar', async () => {
  const id = 404;
  ensureUser(id);
  _setPlatformClientForTests({
    getEntitlement: async () => {
      throw new Error('offline backend failure');
    },
  });
  const status = await resolveEntitlementStatus(id);
  assert.equal(status.canChat, true);
  assert.deepEqual(status.allowedModes, ['text']);
  assert.equal(status.backendVerified, false);
  assert.equal((await verifyPaidMode(id, 'voice')).allowed, false);
  assert.equal((await verifyPaidMode(id, 'avatar')).allowed, false);

  const voiceCtx = fakeCtx(id);
  assert.equal(await sendVoiceReply(voiceCtx, 'Тест'), false);
  assert.deepEqual(voiceCtx.sent.actions, []);

  clearEntitlementCache(id);
  const avatarCtx = fakeCtx(id);
  assert.equal(await sendAvatarReply(avatarCtx, 'Тест'), false);
  assert.equal(avatarCtx.sent.replies.length, 0);
  assert.equal(avatarCtx.sent.videos.length, 0);
});

test('paid-provider check ignores a cached grant and blocks immediate revocation', async () => {
  const id = 406;
  ensureUser(id);
  let entitlement = activeEntitlement(id, 'monthly');
  _setPlatformClientForTests({
    getEntitlement: async () => ({ entitlement }),
  });
  const cached = await resolveEntitlementStatus(id);
  assert.equal(cached.state, 'paid');
  entitlement = null; // revoked inside the normal 30-second cache window
  assert.equal((await verifyPaidMode(id, 'avatar')).allowed, false);
});

test('missing or unknown authorization fields never grant paid access', async () => {
  const id = 407;
  ensureUser(id);
  for (const malformed of [
    {
      telegram_user_id: String(id),
      plan_id: 'monthly',
      expires_at: new Date(Date.now() + DAY_MS).toISOString(),
      modes: ['text', 'voice', 'avatar'],
    },
    {
      telegram_user_id: String(id),
      plan_id: 'monthly',
      status: 'active',
      modes: ['text', 'voice', 'avatar'],
    },
    {
      telegram_user_id: String(id),
      plan_id: 'monthly',
      status: 'active',
      expires_at: new Date(Date.now() + DAY_MS).toISOString(),
    },
    {
      telegram_user_id: String(id),
      plan_id: 'monthly',
      status: 'pending',
      expires_at: new Date(Date.now() + DAY_MS).toISOString(),
      modes: ['text', 'voice', 'avatar'],
    },
  ]) {
    _setPlatformClientForTests({
      getEntitlement: async () => ({ entitlement: malformed }),
    });
    const status = await resolveEntitlementStatus(id, { forceRefresh: true });
    assert.notEqual(status.state, 'paid');
    assert.deepEqual(status.allowedModes, ['text']);
    assert.equal((await verifyPaidMode(id, 'avatar')).allowed, false);
  }
});

test('successful no-entitlement response ignores a stale local paid activation', async () => {
  const id = 405;
  ensureUser(id, Date.now() - 30 * DAY_MS);
  activatePlan(id, 'yearly');
  _setPlatformClientForTests({
    getEntitlement: async () => ({ entitlement: null }),
  });
  const status = await resolveEntitlementStatus(id);
  assert.notEqual(status.state, 'paid');
  assert.equal(status.canChat, false);
  assert.equal((await verifyPaidMode(id, 'avatar')).allowed, false);
});