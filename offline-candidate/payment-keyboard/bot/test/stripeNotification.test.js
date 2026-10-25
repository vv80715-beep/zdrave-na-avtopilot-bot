// Offline contract tests for the inert snapshot of the deployed sender.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FUNCTION_SHA256 = 'c3e6b133501d9bf06a835225acfbae2e96820d7f0f496a0c842fbb7a460d5c24';
const FIXTURE = path.join(__dirname, 'fixtures', 'stripeAutomaticPaymentNotification.txt');
const TOKEN = `12345:${'a'.repeat(20)}`;
const EVENT_ID = '00000000-0000-4000-8000-000000000001';
const PLANS = {
  seven_day: { id: 'seven_day', name: '7-дневен план' },
  monthly: { id: 'monthly', name: 'Месечен план' },
  yearly: { id: 'yearly', name: 'Годишен план' },
};
// Existing project origin (ELI_PURCHASE_URL_ORIGIN and deployed DEFAULT_APP_BASE_URL).
const SITE_ORIGIN = 'https://zdrave-na-avtopilot-dkr6.bolt.host';
const COMMUNITY_URL = require('../paymentComplete').communityUrl({
  ELI_PURCHASE_URL_ORIGIN: SITE_ORIGIN,
});

function loadSender() {
  const fixture = fs.readFileSync(FIXTURE, 'utf8');
  const start = fixture.indexOf('async function sendAutomaticPaymentNotification(');
  assert.ok(start >= 0, 'sender function is present in the inert fixture');
  const source = fixture.slice(start);
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), FUNCTION_SHA256);

  // These exact, asserted rewrites remove only the four TypeScript type sites.
  const replacements = [
    ['  client: ReturnType<typeof getSupabaseClient>,', '  client,'],
    ['  eventId: string | null,', '  eventId,'],
    ['): Promise<Record<string, unknown>> {', ') {'],
    ['  const event = claimed as Record<string, unknown>;', '  const event = claimed;'],
    ['  const plan = PLANS[String(event.plan_id) as PlanId];', '  const plan = PLANS[String(event.plan_id)];'],
  ];
  let javascript = source;
  for (const [typed, plain] of replacements) {
    assert.equal(javascript.split(typed).length - 1, 1, `expected one type site: ${typed}`);
    javascript = javascript.replace(typed, plain);
  }
  assert.doesNotMatch(javascript, /ReturnType<|Promise<|Record<|\sas\sPlanId/);

  const sandbox = {
    AbortSignal,
    Date,
    Intl,
    JSON,
    Number,
    String,
    PLANS,
    Deno: { env: { get: (name) => name === 'TELEGRAM_BOT_TOKEN' ? TOKEN : undefined } },
    getAppBaseUrl: () => SITE_ORIGIN,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${javascript}\nthis.sender = sendAutomaticPaymentNotification;`, sandbox);
  return { sender: sandbox.sender, sandbox };
}

function event(planId = 'monthly') {
  return {
    id: EVENT_ID,
    status: 'pending',
    attempts: 0,
    lease_token: null,
    telegram_user_id: '9000000101',
    plan_id: planId,
    amount_cents: 990,
    access_expires_at: '2026-10-17T12:00:00.000Z',
  };
}

// This deliberately models the observed RPC contract, rather than claiming to
// prove PostgreSQL locking: one pending/retry row is atomically moved to sending.
function mockStore(initialEvent, { claimAllowed = true } = {}) {
  const row = { ...initialEvent };
  const calls = { claims: 0, updates: [] };
  const client = {
    async rpc(name, args) {
      assert.equal(name, 'claim_payment_notification');
      assert.equal(args.p_event_id, row.id);
      calls.claims += 1;
      if (!claimAllowed) return { data: null, error: null };
      if (!['pending', 'retry'].includes(row.status)) return { data: null, error: null };
      row.status = 'sending';
      row.attempts += 1;
      row.lease_token = `lease-${row.attempts}`;
      return { data: { ...row }, error: null };
    },
    from(table) {
      assert.equal(table, 'payment_notification_outbox');
      let patch;
      return {
        select() { return this; },
        update(value) { patch = value; return this; },
        eq(column, value) {
          assert.equal(column, 'id');
          assert.equal(value, row.id);
          if (patch) {
            Object.assign(row, patch);
            calls.updates.push({ ...patch });
          }
          return this;
        },
        async maybeSingle() {
          return {
            data: { status: row.status, last_error_code: row.last_error_code || null },
            error: null,
          };
        },
      };
    },
  };
  return { client, row, calls };
}

function telegramMock({ throwOnSend = false, pauseSend = false } = {}) {
  const calls = [];
  let release;
  const gate = pauseSend && new Promise((resolve) => { release = resolve; });
  const fetch = async (url, options) => {
    assert.match(url, /^https:\/\/api\.telegram\.org\/bot12345:/);
    if (url.endsWith('/getMe')) {
      calls.push({ kind: 'getMe' });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'EliZdraveBot' } }) };
    }
    assert.ok(url.endsWith('/sendMessage'));
    calls.push({ kind: 'sendMessage', payload: JSON.parse(options.body) });
    if (gate) await gate;
    if (throwOnSend) throw new Error('offline indeterminate transport result');
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 71 } }) };
  };
  return { fetch, calls, release: () => release?.() };
}

test('the same event repeated sends exactly once', async () => {
  const { sender, sandbox } = loadSender();
  const store = mockStore(event());
  const telegram = telegramMock();
  sandbox.fetch = telegram.fetch;

  assert.equal((await sender(store.client, EVENT_ID)).status, 'sent');
  assert.equal((await sender(store.client, EVENT_ID)).status, 'sent');
  assert.equal(telegram.calls.filter((call) => call.kind === 'sendMessage').length, 1);
  assert.equal(store.calls.claims, 2);
});

test('concurrent delivery attempts for one event send exactly once', async () => {
  const { sender, sandbox } = loadSender();
  const store = mockStore(event());
  const telegram = telegramMock({ pauseSend: true });
  sandbox.fetch = telegram.fetch;

  const first = sender(store.client, EVENT_ID);
  const second = sender(store.client, EVENT_ID);
  await new Promise((resolve) => setImmediate(resolve));
  telegram.release();
  const results = await Promise.all([first, second]);

  assert.deepEqual(results.map((result) => result.status).sort(), ['sending', 'sent']);
  assert.equal(telegram.calls.filter((call) => call.kind === 'sendMessage').length, 1);
});

test('an uncertain delivery outcome is terminal and is not resent', async () => {
  const { sender, sandbox } = loadSender();
  const store = mockStore(event());
  const telegram = telegramMock({ throwOnSend: true });
  sandbox.fetch = telegram.fetch;

  const first = await sender(store.client, EVENT_ID);
  assert.equal(first.status, 'uncertain');
  assert.equal(first.error_code, 'delivery_outcome_unknown');
  assert.equal((await sender(store.client, EVENT_ID)).status, 'uncertain');
  assert.equal(telegram.calls.filter((call) => call.kind === 'sendMessage').length, 1);
});

for (const [planId, expectedModes] of [
  ['seven_day', 'Включен достъп: текст, глас и Общност.'],
  ['monthly', 'Включен достъп: текст, глас, Avatar видео и Общност.'],
  ['yearly', 'Включен достъп: текст, глас, Avatar видео и Общност.'],
]) {
  test(`Bulgarian message lists the correct ${planId} modes`, async () => {
    const { sender, sandbox } = loadSender();
    const store = mockStore(event(planId));
    const telegram = telegramMock();
    sandbox.fetch = telegram.fetch;

    assert.equal((await sender(store.client, EVENT_ID)).status, 'sent');
    const message = telegram.calls.find((call) => call.kind === 'sendMessage').payload;
    assert.ok(message.text.includes(expectedModes));
    assert.ok(message.text.includes(`${PLANS[planId].name} е активен до `));
    assert.ok(message.text.includes('(българско време).'));
    const button = message.reply_markup.inline_keyboard[0][0];
    assert.equal(COMMUNITY_URL, `${SITE_ORIGIN}/community.html`);
    assert.equal(button.text, 'Отвори Общността');
    assert.equal(button.url, COMMUNITY_URL);
    if (planId === 'seven_day') assert.ok(!message.text.includes('Avatar видео'));
  });
}

test('a denied database claim sends neither a confirmation nor a Community link', async () => {
  // Payment/entitlement verification belongs to the existing database RPC.
  // This test verifies the sender cannot bypass a denied claim.
  const { sender, sandbox } = loadSender();
  const store = mockStore(event(), { claimAllowed: false });
  const telegram = telegramMock();
  sandbox.fetch = telegram.fetch;
  await sender(store.client, EVENT_ID);
  assert.equal(telegram.calls.length, 0);
});

test('trial is not a paid notification plan and cannot receive the Community button', async () => {
  const { sender, sandbox } = loadSender();
  const store = mockStore(event('trial'));
  const telegram = telegramMock();
  sandbox.fetch = telegram.fetch;
  assert.equal((await sender(store.client, EVENT_ID)).status, 'failed');
  assert.equal(telegram.calls.length, 0);
});