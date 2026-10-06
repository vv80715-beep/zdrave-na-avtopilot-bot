// Offline tests: no bot launch, network requests, or entitlement/storage writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const plans = require('../commands/plans');
const startCommands = require('../commands/start');
const { EliPlatformClient } = require('../boltPlatformClient');
const { resolvePaymentCompleteStatus, communityUrl } = require('../paymentComplete');

const NOW = Date.parse('2026-09-17T12:00:00Z');
const ENV = { ELI_COMMUNITY_URL: 'https://community.example.test/join' };
const CONFIRMED = 'Готово — плащането е потвърдено и планът ти е активен. ✅';

function entitlement(overrides = {}) {
  return {
    telegram_user_id: '9000000101',
    active: true,
    plan_id: 'monthly',
    plan: { id: 'monthly', name: 'Месечен' },
    status: 'active',
    billing_status: 'active',
    modes: ['text', 'voice', 'avatar', 'community'],
    avatar_minutes_per_month: 30,
    starts_at: '2026-09-01T00:00:00Z',
    current_period_start: '2026-09-01T00:00:00Z',
    current_period_end: '2026-10-01T00:00:00Z',
    expires_at: '2026-10-01T00:00:00Z',
    cancel_at_period_end: false,
    ...overrides,
  };
}

function context(owner = false, payload = 'payment_complete') {
  const replies = [];
  return {
    owner,
    from: { id: 9000000101, first_name: 'Тест' },
    message: { text: `/start ${payload}` },
    replies,
    reply: async (message, extra) => replies.push({ message, extra }),
  };
}

function receiptOptions(raw, { env = ENV, error = false } = {}) {
  const calls = [];
  const client = new EliPlatformClient({
    secret: 'offline-only-placeholder-'.repeat(2),
    fetchImpl: async (url, options) => {
      // Verify the real canonical client route, not an owner/effective resolver.
      calls.push({ get: url, method: options.method });
      assert.equal(url, 'https://aoaylzncorwakxcactox.supabase.co/functions/v1/api/internal/entitlements/9000000101');
      assert.equal(options.method, 'GET');
      if (error) throw new Error('offline simulated failure');
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          api_version: 1,
          checked_at: new Date(NOW).toISOString(),
          entitlement: raw,
        }),
      };
    },
  });
  return {
    calls,
    options: {
      env,
      clearCache: (id) => calls.push({ clear: id }),
      resolveStatus: (id) => resolvePaymentCompleteStatus(id, { client, now: NOW }),
    },
  };
}

// Register the same pre-stage /start command as production, offline.
function startHandler(options) {
  let handler;
  const calls = { ownerAccess: 0, ensured: 0 };
  startCommands.register({ start: (fn) => { handler = fn; }, help: () => {} }, {
    refreshPaymentComplete: (ctx) => plans.refreshPaymentComplete(ctx, options),
    purchasePlan: () => assert.fail('not a purchase'),
    ensureUser: () => { calls.ensured += 1; },
    isOwner: (ctx) => ctx.owner,
    ownerName: 'Тест',
  });
  return { handler, calls };
}

function communityButtons(ctx) {
  return ctx.replies.flatMap(({ extra }) =>
    (extra?.reply_markup?.inline_keyboard || []).flat()
  ).filter((button) => button.text === 'Отвори Общността ↗');
}

for (const owner of [false, true]) {
  test(`${owner ? 'owner' : 'user'} payment_complete always refreshes canonical backend and shows Community`, async () => {
    const check = receiptOptions(entitlement());
    const { handler, calls } = startHandler(check.options);
    const ctx = context(owner);
    await handler(ctx);
    await handler(ctx);
    assert.equal(calls.ownerAccess, 0);
    assert.deepEqual(check.calls.map((c) => c.clear ? 'clear' : 'GET'), ['clear', 'GET', 'clear', 'GET']);
    assert.equal(check.calls[0].clear, String(ctx.from.id));
    const receipts = ctx.replies.filter(({ message }) => message.startsWith(CONFIRMED));
    assert.equal(receipts.length, 2);
    assert.match(receipts[0].message, /Активен план: Месечен/);
    assert.match(receipts[0].message, /Режими: Текст, Глас, Аватар, Общност/);
    assert.deepEqual(communityButtons(ctx).map((b) => b.url), [ENV.ELI_COMMUNITY_URL, ENV.ELI_COMMUNITY_URL]);
  });
}

for (const [name, raw, error] of [
  ['missing', null, false],
  ['inactive', entitlement({ active: false, status: 'expired', modes: [], avatar_minutes_per_month: 0 }), false],
  ['active flag false', entitlement({ active: false }), false],
  ['unpaid', entitlement({ billing_status: 'pending' }), false],
  ['expired', entitlement({
    current_period_start: '2026-09-01T00:00:00Z',
    current_period_end: '2026-09-02T00:00:00Z',
    expires_at: '2026-09-02T00:00:00Z',
  }), false],
  ['different user', entitlement({ telegram_user_id: '9000000102' }), false],
  ['backend failure', null, true],
]) {
  test(`${name} backend result never confirms payment, even for owner/local paid bypass`, async () => {
    const check = receiptOptions(raw, { error });
    const { handler, calls } = startHandler(check.options);
    const ctx = context(true);
    await handler(ctx);
    assert.equal(calls.ownerAccess, 0);
    assert.equal(check.calls[0].clear, String(ctx.from.id));
    assert.ok(ctx.replies.some(({ message }) => message.includes('Плащането още не е потвърдено от backend-а')));
    assert.ok(ctx.replies.every(({ message }) => !message.startsWith(CONFIRMED)));
    assert.deepEqual(communityButtons(ctx), []);
  });
}

test('paid seven-day plan uses Bulgarian plan and backend modes, with origin fallback', async () => {
  const check = receiptOptions(entitlement({
    plan_id: 'seven_day',
    plan: { id: 'seven_day', name: '7 дни' },
    billing_status: 'paid',
    modes: ['text', 'voice', 'community'],
    avatar_minutes_per_month: 0,
  }), { env: { ELI_PURCHASE_URL_ORIGIN: 'https://website.example.test/nested?ignore=yes#fragment' } });
  const ctx = context();
  await plans.refreshPaymentComplete(ctx, check.options);
  assert.match(ctx.replies[0].message, /Активен план: 7 дни/);
  assert.match(ctx.replies[0].message, /Режими: Текст, Глас, Общност/);
  assert.equal(communityButtons(ctx)[0].url, 'https://website.example.test/community.html');
});

test('invalid or missing community URL never becomes a button', async () => {
  for (const env of [
    {},
    { ELI_COMMUNITY_URL: 'http://community.example.test' },
    { ELI_COMMUNITY_URL: 'javascript:alert(1)' },
    { ELI_COMMUNITY_URL: '//community.example.test' },
    { ELI_COMMUNITY_URL: 'https://user:pass@community.example.test' },
    { ELI_COMMUNITY_URL: 'not a URL', ELI_PURCHASE_URL_ORIGIN: 'https://valid.example.test' },
    { ELI_PURCHASE_URL_ORIGIN: 'http://website.example.test' },
  ]) {
    assert.equal(communityUrl(env), null);
    const check = receiptOptions(entitlement(), { env });
    const ctx = context();
    await plans.refreshPaymentComplete(ctx, check.options);
    assert.ok(ctx.replies[0].message.startsWith(CONFIRMED));
    assert.match(ctx.replies[0].message, /валиден HTTPS адрес/);
    assert.deepEqual(communityButtons(ctx), []);
  }
  assert.equal(communityUrl({
    ELI_COMMUNITY_URL: 'https://community.example.test/join',
    ELI_PURCHASE_URL_ORIGIN: 'https://other.example.test',
  }), 'https://community.example.test/join');
});

test('receipt requires active + paid + backendVerified together', async () => {
  for (const override of [
    { active: false },
    { state: 'owner' },
    { backendVerified: false },
  ]) {
    const ctx = context(true);
    await plans.refreshPaymentComplete(ctx, {
      clearCache: () => {},
      resolveStatus: async () => ({
        active: true, state: 'paid', backendVerified: true,
        plan: 'monthly', allowedModes: ['text'], ...override,
      }),
      env: ENV,
    });
    assert.deepEqual(communityButtons(ctx), []);
    assert.ok(!ctx.replies[0].message.startsWith(CONFIRMED));
  }
});

test('ordinary /start sends one short owner welcome and creates the normal user', async () => {
  const check = receiptOptions(null);
  const { handler, calls } = startHandler(check.options);
  const ctx = context(true, 'ordinary_payload');
  await handler(ctx);
  assert.equal(calls.ensured, 1);
  assert.equal(ctx.replies.length, 1);
  assert.match(ctx.replies[0].message, /Тест/);
  assert.deepEqual(check.calls, []);
});