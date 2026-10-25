// Isolated Stripe/Supabase entitlement regressions. All backend calls are
// in-memory fakes and local entitlement state is redirected to a temporary file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Markup } = require('telegraf');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-stripe-entitlement-'));
process.env.ENTITLEMENTS_PATH = path.join(tmp, 'entitlements.json');
process.env.AVATAR_MODE_PATH = path.join(tmp, 'avatar-mode.json');

const {
  CACHE_TTL_MS,
  resolveEntitlementStatus,
  _setPlatformClientForTests,
} = require('../entitlementResolver');
const { ensureUser, DAY_MS } = require('../entitlements');
const {
  validateEntitlementResponse,
} = require('../boltPlatformClient');
const {
  resolvePaymentCompleteStatus,
} = require('../paymentComplete');
const {
  resolveAccessStatus,
  TRIAL_EXPIRED_MESSAGE,
} = require('../chatGate');
const { modePermissionsText } = require('../modePermissions');

const NOW = Date.parse('2026-09-17T12:00:00Z');

function entitlement(userId, plan = 'monthly', overrides = {}) {
  const modes = plan === 'seven_day'
    ? ['text', 'voice', 'community']
    : ['text', 'voice', 'avatar', 'community'];
  return {
    telegram_user_id: String(userId),
    active: true,
    plan_id: plan,
    plan: { id: plan, name: plan },
    status: 'active',
    billing_status: plan === 'seven_day' ? 'paid' : 'active',
    modes,
    avatar_minutes_per_month:
      modes.includes('avatar') ? (plan === 'yearly' ? 20 : 30) : 0,
    starts_at: new Date(NOW - DAY_MS).toISOString(),
    current_period_start: new Date(NOW - DAY_MS).toISOString(),
    current_period_end: new Date(NOW + 7 * DAY_MS).toISOString(),
    expires_at: new Date(NOW + 7 * DAY_MS).toISOString(),
    cancel_at_period_end: false,
    ...overrides,
  };
}

function useEntitlement(valueOrGetter) {
  _setPlatformClientForTests({
    getEntitlement: async () => ({
      entitlement: typeof valueOrGetter === 'function'
        ? valueOrGetter()
        : valueOrGetter,
    }),
  });
}

function liveEntitlement(userId, plan = 'monthly', overrides = {}) {
  const now = Date.now();
  return entitlement(userId, plan, {
    starts_at: new Date(now - DAY_MS).toISOString(),
    current_period_start: new Date(now - DAY_MS).toISOString(),
    current_period_end: new Date(now + 7 * DAY_MS).toISOString(),
    expires_at: new Date(now + 7 * DAY_MS).toISOString(),
    ...overrides,
  });
}

function modeHandlers(initialMode = 'text') {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const start = source.indexOf('// ── Chat modes: text / voice / avatar');
  const end = source.indexOf('\nmyprofile.register(bot);', start);
  assert.ok(start >= 0 && end > start);

  let commandHandler;
  const hears = new Map();
  let storedMode = initialMode;
  const bot = {
    command(name, handler) {
      if (name === 'mode') commandHandler = handler;
    },
    hears(label, handler) {
      hears.set(label, handler);
    },
  };
  vm.runInNewContext(source.slice(start, end), {
    bot,
    resolveAccessStatus,
    modePermissionsText,
    TRIAL_EXPIRED_MESSAGE,
    planKeyboard: () => ({ reply_markup: { inline_keyboard: [['plans']] } }),
    getMode: () => storedMode,
    setMode: (_id, mode) => { storedMode = mode; },
    Markup,
    parseCommandText: () => null,
  });
  assert.equal(typeof commandHandler, 'function');
  return {
    showModeSelector: commandHandler,
    selectAvatar: hears.get('Говори с аватара на Ели'),
    getStoredMode: () => storedMode,
  };
}

function modeContext(id) {
  const replies = [];
  return {
    from: { id },
    replies,
    reply: async (message, extra) => replies.push({ message, extra }),
  };
}

test.after(() => {
  _setPlatformClientForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('original trial remains text-only without a backend entitlement', async () => {
  const id = 9100000001;
  ensureUser(id, NOW);
  useEntitlement(null);

  const status = await resolveEntitlementStatus(id, { now: NOW });
  assert.equal(status.state, 'trial');
  assert.equal(status.canChat, true);
  assert.deepEqual(status.allowedModes, ['text']);
});

test('paid plan matrix is derived from the plan and never grants seven-day Avatar', async () => {
  for (const [offset, plan, expected] of [
    [2, 'seven_day', ['text', 'voice']],
    [3, 'monthly', ['text', 'voice', 'avatar']],
    [4, 'yearly', ['text', 'voice', 'avatar']],
  ]) {
    const id = 9100000000 + offset;
    ensureUser(id, NOW);
    const raw = entitlement(id, plan);
    if (plan === 'seven_day') raw.modes.push('avatar');
    useEntitlement(raw);

    const status = await resolveEntitlementStatus(id, { now: NOW });
    assert.equal(status.state, 'paid');
    assert.equal(status.plan, plan);
    assert.deepEqual(status.allowedModes, expected);
  }
});

test('future, unpaid, wrong-user, inactive, and expired records cannot authorize', async () => {
  const cases = [
    { starts_at: new Date(NOW + 1).toISOString() },
    { billing_status: 'pending' },
    { telegram_user_id: '9100000999' },
    { active: false },
    { status: 'expired' },
    { expires_at: new Date(NOW).toISOString() },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const id = 9100000010 + index;
    ensureUser(id, NOW);
    useEntitlement(entitlement(id, 'monthly', cases[index]));
    const status = await resolveEntitlementStatus(id, {
      forceRefresh: true,
      now: NOW,
    });
    assert.notEqual(status.state, 'paid');
    assert.deepEqual(status.allowedModes, ['text']);
  }
});

test('a newly active entitlement automatically reactivates access and preserves extras', async () => {
  const id = 9100000020;
  const local = ensureUser(id, NOW - 30 * DAY_MS);
  local.extras = { purchasedAvatarMinutes: 17 };
  fs.writeFileSync(
    process.env.ENTITLEMENTS_PATH,
    JSON.stringify({ [id]: local }, null, 2)
  );

  let backend = entitlement(id, 'monthly', {
    active: false,
    status: 'expired',
    modes: [],
    avatar_minutes_per_month: 0,
    expires_at: new Date(NOW - DAY_MS).toISOString(),
  });
  useEntitlement(() => backend);
  const expired = await resolveEntitlementStatus(id, {
    forceRefresh: true,
    now: NOW,
  });
  assert.equal(expired.state, 'paid_expired');
  assert.equal(expired.canChat, false);

  backend = entitlement(id, 'yearly');
  const active = await resolveEntitlementStatus(id, {
    forceRefresh: true,
    now: NOW,
  });
  assert.equal(active.state, 'paid');
  assert.deepEqual(active.allowedModes, ['text', 'voice', 'avatar']);
  const stored = JSON.parse(fs.readFileSync(
    process.env.ENTITLEMENTS_PATH,
    'utf8'
  ));
  assert.deepEqual(stored[id].extras, { purchasedAvatarMinutes: 17 });
});

test('cached and stale paid text access are bounded by both TTL and expiry', async () => {
  const id = 9100000030;
  ensureUser(id, NOW - 30 * DAY_MS);
  const expiresAt = NOW + 1000;
  let fail = false;
  let backend = entitlement(id, 'monthly', {
    current_period_end: new Date(expiresAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
  });
  useEntitlement(() => {
    if (fail) throw new Error('backend unavailable');
    return backend;
  });

  assert.equal((await resolveEntitlementStatus(id, { now: NOW })).state, 'paid');
  fail = true;
  const briefFallback = await resolveEntitlementStatus(id, {
    forceRefresh: true,
    now: NOW + 500,
  });
  assert.equal(briefFallback.state, 'backend_unavailable');
  assert.deepEqual(briefFallback.allowedModes, ['text']);

  const afterExpiry = await resolveEntitlementStatus(id, {
    now: expiresAt + 1,
  });
  assert.equal(afterExpiry.state, 'paid_expired');
  assert.equal(afterExpiry.canChat, false);

  // A long-lived plan is likewise not retained after the original cache TTL.
  backend = entitlement(id, 'monthly');
  fail = false;
  await resolveEntitlementStatus(id, { forceRefresh: true, now: NOW });
  fail = true;
  const afterTtl = await resolveEntitlementStatus(id, {
    now: NOW + CACHE_TTL_MS + 1,
  });
  assert.equal(afterTtl.state, 'paid_expired');
  assert.equal(afterTtl.canChat, false);
});

test('canonical response and payment receipt clamp modes and require a started period', async () => {
  const id = 9100000040;
  const raw = entitlement(id, 'seven_day', {
    modes: ['text', 'voice', 'avatar', 'community'],
    avatar_minutes_per_month: 0,
  });
  const validated = validateEntitlementResponse({
    api_version: 1,
    checked_at: new Date(NOW).toISOString(),
    entitlement: raw,
  }, String(id));
  assert.deepEqual(validated.entitlement.modes, ['text', 'voice', 'community']);

  const client = { getEntitlement: async () => ({ entitlement: raw }) };
  const receipt = await resolvePaymentCompleteStatus(id, { client, now: NOW });
  assert.equal(receipt.active, true);
  assert.deepEqual(receipt.allowedModes, ['text', 'voice', 'community']);

  const future = await resolvePaymentCompleteStatus(id, {
    client: {
      getEntitlement: async () => ({
        entitlement: entitlement(id, 'monthly', {
          starts_at: new Date(NOW + 1).toISOString(),
        }),
      }),
    },
    now: NOW,
  });
  assert.equal(future.active, false);
});

test('actual /mode handler force-refreshes a previously cached Trial', async () => {
  const id = 9100000050;
  ensureUser(id);
  let backend = null;
  useEntitlement(() => backend);
  const cached = await resolveEntitlementStatus(id);
  assert.equal(cached.state, 'trial');

  backend = liveEntitlement(id, 'monthly');
  const handlers = modeHandlers();
  const ctx = modeContext(id);
  await handlers.showModeSelector(ctx);

  assert.match(ctx.replies[0].message, /Текст: ✅/);
  assert.match(ctx.replies[0].message, /Глас: ✅/);
  assert.match(ctx.replies[0].message, /Аватар: ✅/);
  const labels = ctx.replies[0].extra.reply_markup.keyboard.flat();
  assert.deepEqual(
    [...labels],
    ['Пиши с Ели', 'Говори с Ели', 'Говори с аватара на Ели']
  );
});

test('actual /mode handler immediately locks an expired cached paid plan', async () => {
  const id = 9100000051;
  ensureUser(id, Date.now() - 30 * DAY_MS);
  let backend = liveEntitlement(id, 'monthly');
  useEntitlement(() => backend);
  assert.equal((await resolveEntitlementStatus(id)).state, 'paid');

  backend = liveEntitlement(id, 'monthly', {
    active: false,
    status: 'expired',
    modes: [],
    avatar_minutes_per_month: 0,
    expires_at: new Date(Date.now() - 1).toISOString(),
  });
  const handlers = modeHandlers('avatar');
  const ctx = modeContext(id);
  await handlers.showModeSelector(ctx);

  assert.match(ctx.replies[0].message, /Текст: 🔒/);
  assert.match(ctx.replies[0].message, /Глас: 🔒/);
  assert.match(ctx.replies[0].message, /Аватар: 🔒/);
  assert.match(ctx.replies[0].message, new RegExp(TRIAL_EXPIRED_MESSAGE.slice(0, 30)));
  assert.equal(ctx.replies[0].extra.reply_markup.keyboard, undefined);
});

test('actual mode handlers reject stale Avatar selection on seven_day', async () => {
  const id = 9100000052;
  ensureUser(id);
  let backend = liveEntitlement(id, 'monthly');
  useEntitlement(() => backend);
  assert.equal((await resolveEntitlementStatus(id)).plan, 'monthly');
  backend = liveEntitlement(id, 'seven_day');

  const handlers = modeHandlers('voice');
  const selectorCtx = modeContext(id);
  await handlers.showModeSelector(selectorCtx);
  assert.match(selectorCtx.replies[0].message, /Текст: ✅/);
  assert.match(selectorCtx.replies[0].message, /Глас: ✅/);
  assert.match(selectorCtx.replies[0].message, /Аватар: 🔒/);
  assert.deepEqual(
    [...selectorCtx.replies[0].extra.reply_markup.keyboard.flat()],
    ['Пиши с Ели', 'Говори с Ели']
  );

  const staleCtx = modeContext(id);
  await handlers.selectAvatar(staleCtx);
  assert.match(staleCtx.replies[0].message, /не е включена в текущия ти план/);
  assert.equal(handlers.getStoredMode(), 'voice');
});