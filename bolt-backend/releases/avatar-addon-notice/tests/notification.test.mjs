import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import { buildPaymentNotification, dispatchPaymentNotification } from '../supabase/functions/_shared/payment-notification.mjs';
import { buildPaymentNotification as baselineRenderer } from '../baseline/functions/_shared/payment-notification.mjs';
import { deliverAvatarAddonNotification } from '../supabase/functions/_shared/avatar-addon-aftercare.mjs';
import { notificationStore } from '../supabase/functions/_shared/payment-notification-store.mjs';

const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('supabase/functions/api/index.ts', root), 'utf8');
const baseline = fs.readFileSync(new URL('baseline/functions/api/index.ts', root), 'utf8');
const ID = '11111111-1111-4111-8111-111111111111';
const PURCHASE = '22222222-2222-4222-8222-222222222222';
const LEASE = '33333333-3333-4333-8333-333333333333';
const CHAT = '990000001';
const TOKEN = '123456:TEST_ONLY_NOT_A_REAL_TELEGRAM_TOKEN';
const now = Date.now();
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
const expected = minutes => `✅ Плащането е потвърдено. Добавихме ${minutes} допълнителни Avatar минути към профила ти. Те не изтичат и се използват след включеното Avatar време от плана.`;
function event(minutes = 20) {
  return {
    id: ID, event_type: 'payment_confirmed_avatar_addon_credited',
    addon_purchase_id: PURCHASE, addon_checkout_session_id: 'cs_local_only',
    addon_minutes: minutes, addon_seconds: minutes * 60, telegram_user_id: CHAT,
    payment_id: null, purchase_session_id: null, plan_id: null, access_expires_at: null,
    amount_cents: 50, currency: 'eur', paid_at: new Date(now - 1000).toISOString(),
    status: 'sending', lease_token: LEASE, attempts: 1,
  };
}
function senderHarness(options = {}) {
  let status = 'pending', attempts = 0, sends = 0;
  const results = [];
  const store = {
    async claim() {
      if (!['pending', 'retry'].includes(status)) return null;
      status = 'sending'; attempts++;
      return { ...event(options.minutes), attempts, ...options.event };
    },
    async status() { return status; },
    async finish(_event, result) {
      if (options.ackFailure) throw Error('mock_ack_loss');
      results.push(result); status = result.status;
    },
  };
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/getMe')) {
      return reply({ ok: true, result: { is_bot: true, username: options.wrongBot ? 'OtherBot' : 'EliZdraveBot' } });
    }
    assert(url.endsWith('/sendMessage')); sends++;
    assert.deepEqual(JSON.parse(init.body), { chat_id: CHAT, text: expected(options.minutes || 20) });
    if (options.timeout) throw Error('mock_ambiguous_timeout');
    if (options.reply) return options.reply(sends);
    return reply({ ok: true, result: { message_id: 42, chat: { id: Number(CHAT) } } });
  };
  return {
    run: () => dispatchPaymentNotification({ eventId: ID, store, fetchImpl, botToken: TOKEN, now }),
    info: () => ({ status, attempts, sends, results }),
    expireLease: () => { if (status === 'sending') status = 'uncertain'; },
  };
}

for (const minutes of [20, 50, 100, 200]) {
  test(`exact Bulgarian receipt: ${minutes} purchased minutes, no extra text/buttons`, () => {
    assert.deepEqual(buildPaymentNotification(event(minutes), { now }), { chat_id: CHAT, text: expected(minutes) });
  });
}
test('strict renderer rejects unverified/malformed/mixed events', () => {
  for (const patch of [
    { addon_minutes: 30 }, { addon_minutes: '20' }, { addon_seconds: 30 }, { amount_cents: 100 },
    { currency: 'usd' }, { status: 'pending' }, { status: 'paid' }, { addon_purchase_id: null },
    { addon_checkout_session_id: null }, { lease_token: null }, { paid_at: 'invalid' },
    { paid_at: new Date(now + 120000).toISOString() }, { telegram_user_id: '-1' },
    { telegram_user_id: '9999999999999999' }, { payment_id: PURCHASE },
    { purchase_session_id: PURCHASE }, { access_expires_at: new Date(now + 100000).toISOString() },
    { plan_id: 'monthly' }, { attempts: 0 }, { attempts: 6 }, { event_type: 'unknown' },
  ]) assert.throws(() => buildPaymentNotification({ ...event(), ...patch }, { now }));
});
test('sequential and 20 concurrent dispatches send only once', async () => {
  const h = senderHarness();
  await Promise.all(Array.from({ length: 20 }, () => h.run()));
  await h.run();
  assert.equal(h.info().sends, 1);
  assert.equal(h.info().attempts, 1);
  assert.equal(h.info().status, 'sent');
});
for (const scenario of ['timeout', 'ackFailure']) {
  test(`${scenario}: ambiguous outcome is never blindly retried`, async () => {
    const h = senderHarness({ [scenario]: true });
    assert.equal((await h.run()).status, 'uncertain');
    await h.run(); h.expireLease(); await h.run();
    assert.equal(h.info().sends, 1);
    assert.equal(h.info().status, 'uncertain');
  });
}
for (const [name, response] of [
  ['server 500', () => reply({ ok: false, error_code: 500 }, 500)],
  ['invalid JSON', () => new Response('not-json')],
  ['wrong returned chat', () => reply({ ok: true, result: { message_id: 42, chat: { id: 12345 } } })],
]) {
  test(`${name}: retain uncertain`, async () => {
    const h = senderHarness({ reply: response });
    assert.equal((await h.run()).status, 'uncertain');
    await h.run();
    assert.equal(h.info().sends, 1);
  });
}
test('definitive 429 may retry, then delivered once', async () => {
  const h = senderHarness({ reply: n => n === 1
    ? reply({ ok: false, error_code: 429, parameters: { retry_after: 60 } }, 429)
    : reply({ ok: true, result: { message_id: 42, chat: { id: Number(CHAT) } } }) });
  assert.equal((await h.run()).status, 'retry');
  assert.equal((await h.run()).status, 'sent');
  await h.run();
  assert.equal(h.info().sends, 2); // first attempt explicitly rejected, one accepted delivery
});
test('permanent rejection is terminal', async () => {
  const h = senderHarness({ reply: () => reply({ ok: false, error_code: 403 }, 403) });
  assert.equal((await h.run()).status, 'failed');
  await h.run();
  assert.equal(h.info().sends, 1);
});
test('wrong bot cannot claim or send', async () => {
  const h = senderHarness({ wrongBot: true });
  assert.equal((await h.run()).error_code, 'eli_bot_identity_not_verified');
  assert.equal(h.info().attempts, 0);
});

// Execute the actual live-derived API functions with imports/serve stubbed.
// No app starts; no network, real identity, customer storage or real credentials.
function apiHarness(options = {}) {
  let credited = false, balance = 0, notices = 0, sends = 0, status = options.status || 'checkout_created';
  let outbox = null;
  const db = {
    async rpc(name) {
      if (name === 'claim_payment_notification') {
        if (!outbox || !['pending', 'retry'].includes(outbox.status)) return { data: null };
        outbox.status = 'sending'; outbox.attempts++;
        return { data: { ...outbox } };
      }
      assert.equal(name, 'credit_avatar_addon_purchase');
      if (options.creditError) return { error: Error('credit_failed') };
      if (!['paid', 'pending', 'checkout_created'].includes(status)) return { error: Error('not_payable') };
      const duplicate = credited;
      if (!credited) {
        credited = true; balance += 1200; status = 'paid';
        outbox = { ...event(), status: 'pending', attempts: 0 };
      }
      return { data: [{ duplicate, telegram_user_id: CHAT, credited_seconds: 1200, addon_purchased_seconds: balance, addon_used_seconds: 0 }] };
    },
    from(table) {
      if (table === 'payment_notification_outbox') {
        const filters = [];
        let patch;
        return {
          select() { return this; }, eq(k, v) { filters.push([k, v]); return this; },
          update(value) { patch = value; return this; },
          async maybeSingle() {
            if (!outbox || filters.some(([k, v]) => outbox[k] !== v)) return { data: null };
            if (patch) {
              if (options.ackFailure) return { error: Error('mock_ack_failure') };
              Object.assign(outbox, patch);
            }
            return { data: { ...outbox } };
          },
        };
      }
      assert.equal(table, 'avatar_addon_purchases');
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: { status } }; },
        update(patch) { status = patch.status; return this; },
      };
    },
  };
  const context = vm.createContext({
    Request, Response, URL, URLSearchParams, TextEncoder, Uint8Array, crypto: webcrypto, console,
    Deno: { serve() {}, env: { get(name) { return name === 'TELEGRAM_BOT_TOKEN' ? TOKEN : undefined; } } },
    deliverAvatarAddonNotification: options.realDelivery ? deliverAvatarAddonNotification : async () => {
      notices++;
      assert(credited); assert.equal(balance, 1200); assert.equal(status, 'paid');
      if (options.deliveryFailure) return { status: 'uncertain' };
      if (outbox.status !== 'sent') { sends++; outbox.status = 'sent'; }
      return { status: outbox.status };
    },
    fetch() { throw Error('network_forbidden_in_test'); },
  });
  const code = ts.transpile(source.replace(/^import .*;\r?\n/gm, ''), { target: ts.ScriptTarget.ES2022 });
  vm.runInContext(code + '\n globalThis.api = { handleAvatarAddonCheckoutCompleted, handleAvatarAddonCheckoutFailed, processWebhookEvent, createAvatarAddonCheckout };', context);
  const session = { id: 'cs_local_only', payment_status: 'paid', amount_total: 50, currency: 'eur',
    metadata: { purchase_kind: 'avatar_addon', addon_purchase_id: PURCHASE, addon_minutes: '200' } };
  return { db, context, api: context.api, session,
    info: () => ({ credited, balance, notices, sends, status, outboxStatus: outbox?.status }) };
}
for (const outcome of ['success', 'timeout', 'ackFailure', 'rejected']) {
  test(`integrated actual API → committed mock DB → real shared sender: ${outcome}`, async t => {
    const h = apiHarness({ realDelivery: true, ackFailure: outcome === 'ackFailure' });
    let sends = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert(url.startsWith('https://api.telegram.org/bot' + TOKEN + '/'));
      if (url.endsWith('/getMe')) return reply({ ok: true, result: { is_bot: true, username: 'EliZdraveBot' } });
      assert(url.endsWith('/sendMessage'));
      assert.equal(h.info().status, 'paid'); assert.equal(h.info().balance, 1200);
      assert.equal(h.info().outboxStatus, 'sending');
      sends++;
      assert.deepEqual(JSON.parse(init.body), { chat_id: CHAT, text: expected(20) });
      if (outcome === 'timeout') throw Error('mock_timeout_after_acceptance');
      if (outcome === 'rejected') return reply({ ok: false, error_code: 403 }, 403);
      return reply({ ok: true, result: { message_id: 42, chat: { id: Number(CHAT) } } });
    });
    const first = await h.api.handleAvatarAddonCheckoutCompleted(h.db, h.session, 'evt_integrated1');
    assert.equal(first.action, 'avatar_addon_credited');
    assert.equal(first.notification.status, outcome === 'success' ? 'sent' : outcome === 'rejected' ? 'failed' : 'uncertain');
    await h.api.handleAvatarAddonCheckoutCompleted(h.db, h.session, 'evt_integrated2');
    assert.equal(sends, 1); assert.equal(h.info().balance, 1200); assert.equal(h.info().status, 'paid');
  });
}
test('actual API: credit commits first; repeated webhook preserves one credit/notice', async () => {
  const h = apiHarness();
  const first = await h.api.handleAvatarAddonCheckoutCompleted(h.db, h.session, 'evt_mock1');
  assert.equal(first.action, 'avatar_addon_credited');
  assert.equal(first.creditedSeconds, 1200); // not metadata's 200 minutes
  const second = await h.api.handleAvatarAddonCheckoutCompleted(h.db, h.session, 'evt_mock2');
  assert.equal(second.action, 'avatar_addon_already_credited');
  assert.equal(h.info().balance, 1200);
  assert.equal(h.info().sends, 1);
});
for (const paymentStatus of ['unpaid', 'failed', 'cancelled', 'expired']) {
  test(`actual API: ${paymentStatus} never credits or notifies`, async () => {
    const h = apiHarness();
    await h.api.handleAvatarAddonCheckoutCompleted(h.db, { ...h.session, payment_status: paymentStatus }, 'evt_mock');
    assert.equal(h.info().notices, 0); assert.equal(h.info().balance, 0);
  });
}
for (const type of ['checkout.session.expired', 'checkout.session.async_payment_failed']) {
  test(`actual event routing: ${type} sends nothing`, async () => {
    const h = apiHarness();
    await h.api.processWebhookEvent(h.db, { type, id: 'evt_mock', data: { object: h.session } });
    assert.equal(h.info().notices, 0); assert.equal(h.info().balance, 0);
  });
}
test('actual API: credit failure suppresses notification', async () => {
  const h = apiHarness({ creditError: true });
  await assert.rejects(h.api.handleAvatarAddonCheckoutCompleted(h.db, h.session, 'evt_mock'));
  assert.equal(h.info().notices, 0);
});
test('actual API: Telegram failure leaves successful purchase/minutes intact', async () => {
  const h = apiHarness({ deliveryFailure: true });
  const result = await h.api.handleAvatarAddonCheckoutCompleted(h.db, h.session, 'evt_mock');
  assert.equal(result.action, 'avatar_addon_credited');
  assert.equal(result.notification.status, 'uncertain');
  assert.equal(h.info().balance, 1200); assert.equal(h.info().status, 'paid');
});
test('Owner/Admin bypass and customer plan gate remain functional (mock Checkout)', async () => {
  const h = apiHarness();
  let checkoutCalls = 0, admin = true;
  Object.assign(h.context, {
    getAuthUserId: async () => PURCHASE,
    getCommunityProfile: async () => ({ is_admin: admin, telegram_user_id: CHAT }),
    resolveEffectiveTelegramUserId: async () => Number(CHAT),
    getCommunityEntitlement: async () => ({ is_admin: admin, active: false, plan_id: 'none' }),
    getAppBaseUrl: () => 'https://local.invalid',
    stripeRequest: async (_path, init) => {
      checkoutCalls++;
      assert.equal(new URLSearchParams(init.body).get('line_items[0][price_data][unit_amount]'), '50');
      return { id: 'cs_mock', url: 'https://local.invalid/checkout' };
    },
  });
  const db = { from() { return { insert: async () => ({}), update() { return this; }, eq: async () => ({}) }; } };
  const request = () => new Request('https://local.invalid', { method: 'POST', body: '{"minutes":20}' });
  assert.equal((await h.api.createAvatarAddonCheckout(request(), db)).status, 200);
  admin = false;
  assert.equal((await h.api.createAvatarAddonCheckout(request(), db)).status, 403);
  assert.equal(checkoutCalls, 1);
});
test('hook does not backfill missing historical event and catches DB failure', async () => {
  const queries = [];
  const db = { from(table) {
    assert.equal(table, 'payment_notification_outbox');
    return { select() { return this; }, eq(k, v) { queries.push([k, v]); return this; },
      async maybeSingle() { return { data: null }; } };
  } };
  assert.equal((await deliverAvatarAddonNotification(db, PURCHASE, 'cs_mock', () => TOKEN)).status, 'not_queued');
  assert(queries.some(([k, v]) => k === 'addon_checkout_session_id' && v === 'cs_mock'));
  assert.equal((await deliverAvatarAddonNotification({ from() { throw Error('mock'); } }, PURCHASE, 'cs_mock', () => TOKEN)).status, 'deferred');
});
test('ack adapter fences by id, sending status and lease, and rejects lost ack', async () => {
  const predicates = [];
  const db = { from() { return { update() { return this; }, select() { return this; },
    eq(...args) { predicates.push(args); return this; }, async maybeSingle() { return { data: null }; } }; } };
  await assert.rejects(notificationStore(db).finish(event(), { status: 'sent', message_id: 42 }), /notification_ack_failed/);
  assert.deepEqual(predicates, [['id', ID], ['status', 'sending'], ['lease_token', LEASE]]);
});
for (const plan of ['seven_day', 'monthly', 'yearly']) {
  test(`plan renderer ${plan} byte-equivalent to deployed baseline`, () => {
    const e = { ...event(), event_type: 'payment_confirmed_plan_activated', payment_id: PURCHASE,
      purchase_session_id: LEASE, plan_id: plan, amount_cents: 100,
      access_expires_at: new Date(now + 86400000).toISOString() };
    assert.deepEqual(buildPaymentNotification(e, { now }), baselineRenderer(e, { now }));
  });
}
test('API diff consists exclusively of import, post-credit hook and result field', () => {
  const restored = source
    .replace('import { deliverAvatarAddonNotification } from "../_shared/avatar-addon-aftercare.mjs";\n', '')
    .replace('  // The credit transaction (including its durable notice) has committed.\n  // Delivery failure must never invalidate payment or re-credit the purchase.\n  const notification = await deliverAvatarAddonNotification(\n    client, purchaseId, checkoutSessionId, (name: string) => Deno.env.get(name),\n  );\n\n', '')
    .replace('    notification,\n', '');
  assert.equal(restored, baseline);
});
test('credit arithmetic and original duplicate branch are byte-equivalent to live SQL', () => {
  const migration = fs.readFileSync(new URL('supabase/migrations/20261001150000_avatar_addon_notification.sql', root), 'utf8');
  const original = fs.readFileSync(new URL('baseline/credit_avatar_addon_purchase.sql', root), 'utf8').trim();
  const candidate = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.credit_avatar_addon_purchase'),
    migration.indexOf('$function$;', migration.indexOf('CREATE OR REPLACE FUNCTION public.credit_avatar_addon_purchase')) + '$function$;'.length);
  const restored = candidate.replace(/\n  -- Credit, paid purchase and receipt are atomic; dispatch happens AFTER commit\.[\s\S]*?\n  \);\n/, '');
  assert.equal(restored.replace(/;\s*$/, '').trim(), original.replace(/;\s*$/, '').trim());
});
test('existing aftercare store logic is extracted unchanged', () => {
  const original = fs.readFileSync(new URL('baseline/functions/payment-aftercare/index.ts', root), 'utf8');
  const body = original.slice(original.indexOf('function notificationStore('), original.indexOf('\nasync function deliver('));
  const extracted = fs.readFileSync(new URL('supabase/functions/_shared/payment-notification-store.mjs', root), 'utf8');
  assert.equal(extracted.slice(extracted.indexOf('function notificationStore(')).trim(), body.trim());
});