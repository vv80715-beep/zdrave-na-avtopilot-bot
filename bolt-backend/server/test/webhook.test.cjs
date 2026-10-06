'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { StripeWebhookService } = require('../webhookService');
const { computePlanPeriod } = require('../entitlementWriter');
const { PLANS } = require('../plans');

const WEBHOOK_SECRET = 'whsec_test_secret_12345678901234567890';
const CHECKOUT_SESSION_ID = 'cs_test_abc123def456';
const PAYMENT_ID = '11111111-2222-3333-4444-555555555555';
const TELEGRAM_USER_ID = 8934490753;
const EVENT_ID = 'evt_test_001';
const NOW = new Date('2026-08-19T10:00:00.000Z');

/**
 * Creates a mock Stripe object whose webhooks.constructEvent
 * returns a controlled event. The raw body/signature are not
 * actually verified — the mock just returns the event.
 */
function makeMockStripeService(event) {
  return {
    verifyWebhookEvent: (rawBody, signature) => {
      if (signature === 'invalid-signature') {
        throw new Error('No signatures found matching the expected signature for payload');
      }
      return event;
    },
    createCheckoutSession: async () => { throw new Error('not used'); },
  };
}

/**
 * In-memory mock for the Supabase client, covering only
 * stripe_events insert/update/select, payments operations,
 * and entitlements upsert.
 */
function makeMockClient() {
  const events = new Map();
  const payments = new Map();
  const entitlements = new Map();

  return {
    _events: events,
    _payments: payments,
    _entitlements: entitlements,

    from(table) {
    const self = this;

    if (table === 'stripe_events') {
      let filterField = null, filterValue = null;
      const builder = {
        insert(row) {
          // Check if event_id already exists
          if (events.has(row.event_id)) {
            const res = { error: { code: '23505', message: 'duplicate key' } };
            return { ...res, select: () => res };
          }
          events.set(row.event_id, { ...row });
          return { error: null };
        },
        update(patch) {
          return {
            eq(field, value) {
              const existing = events.get(value);
              if (existing) Object.assign(existing, patch);
              return { error: null };
            },
          };
        },
        select() {
          return {
            eq(field, value) {
              const row = events.get(value);
              return { maybeSingle: async () => ({ data: row || null, error: null }) };
            },
          };
        },
      };
      return builder;
    }

    if (table === 'payments') {
      const builder = {
        insert(row) {
          payments.set(row.id, { ...row });
          return { select: () => ({ single: async () => ({ data: { ...row }, error: null }) }) };
        },
        update(patch) {
          return {
            eq(field, value) {
              let updated = null;
              for (const [id, p] of payments) {
                if (p.stripe_checkout_session_id === value) {
                  Object.assign(p, patch);
                  updated = p;
                }
              }
              return { select: () => ({ maybeSingle: async () => ({ data: updated, error: null }) }) };
            },
          };
        },
        select() {
          return {
            eq(field, value) {
              let found = null;
              for (const [id, p] of payments) {
                if (field === 'stripe_checkout_session_id' && p.stripe_checkout_session_id === value) found = p;
                if (field === 'id' && p.id === value) found = p;
              }
              return { maybeSingle: async () => ({ data: found, error: null }) };
            },
          };
        },
      };
      return builder;
    }

    if (table === 'entitlements') {
      const builder = {
        upsert(row) {
          entitlements.set(row.telegram_user_id, { ...row });
          return { select: () => ({ single: async () => ({ data: { ...row }, error: null }) }) };
        },
        select() {
          return {
            eq(field, value) {
              const row = entitlements.get(value);
              return { maybeSingle: async () => ({ data: row || null, error: null }) };
            },
          };
        },
      };
      return builder;
    }

    return {};
  },
  };
}

function makePaymentService(client) {
  return {
    async createPendingPayment({ paymentId, telegramUserId, planId, stripeCheckoutSessionId, stripeEventId }) {
      const row = {
        id: paymentId,
        telegram_user_id: Number(telegramUserId),
        plan_id: planId,
        stripe_checkout_session_id: stripeCheckoutSessionId,
        status: 'pending',
        first_stripe_event_id: stripeEventId,
        last_stripe_event_id: stripeEventId,
      };
      client._payments.set(paymentId, row);
      return row;
    },
    async findByCheckoutSessionId(csId) {
      for (const [id, p] of client._payments) {
        if (p.stripe_checkout_session_id === csId) return p;
      }
      return null;
    },
    async markPaid({ stripeCheckoutSessionId, stripePaymentIntentId, stripeSubscriptionId, stripeCustomerId, stripeEventId }) {
      for (const [id, p] of client._payments) {
        if (p.stripe_checkout_session_id === stripeCheckoutSessionId) {
          p.status = 'paid';
          p.paid_at = NOW.toISOString();
          p.last_stripe_event_id = stripeEventId;
          if (stripePaymentIntentId) p.stripe_payment_intent_id = stripePaymentIntentId;
          if (stripeSubscriptionId) p.stripe_subscription_id = stripeSubscriptionId;
          if (stripeCustomerId) p.stripe_customer_id = stripeCustomerId;
          return p;
        }
      }
      return null;
    },
    async markFailed({ stripeCheckoutSessionId, stripeEventId }) {
      for (const [id, p] of client._payments) {
        if (p.stripe_checkout_session_id === stripeCheckoutSessionId) {
          p.status = 'failed';
          p.last_stripe_event_id = stripeEventId;
          return p;
        }
      }
      return null;
    },
  };
}

function makeEntitlementWriter(client, now = () => NOW) {
  return {
    async activateEntitlement({ telegramUserId, planId, paymentId, stripeCustomerId, stripeSubscriptionId }) {
      const plan = PLANS[planId];
      const period = computePlanPeriod(planId, now());
      const row = {
        telegram_user_id: Number(telegramUserId),
        plan_id: planId,
        status: 'active',
        billing_status: planId === 'seven_day' ? 'paid' : 'active',
        source_payment_id: paymentId,
        starts_at: period.startsAt.toISOString(),
        current_period_start: period.currentPeriodStart.toISOString(),
        current_period_end: period.currentPeriodEnd.toISOString(),
        expires_at: period.expiresAt.toISOString(),
        cancel_at_period_end: false,
        stripe_subscription_id: stripeSubscriptionId || null,
        stripe_customer_id: stripeCustomerId || null,
      };
      client._entitlements.set(Number(telegramUserId), row);
      return row;
    },
  };
}

function buildWebhookService(client, event) {
  const stripeService = makeMockStripeService(event);
  const paymentService = makePaymentService(client);
  const entitlementWriter = makeEntitlementWriter(client);
  return new StripeWebhookService({
    client,
    stripeService,
    paymentService,
    entitlementWriter,
    now: () => NOW,
  });
}

function checkoutCompletedEvent(overrides = {}) {
  return {
    id: EVENT_ID,
    type: 'checkout.session.completed',
    livemode: false,
    data: {
      object: {
        id: CHECKOUT_SESSION_ID,
        payment_status: 'paid',
        payment_intent: 'pi_test_123',
        subscription: null,
        customer: 'cus_test_123',
        ...overrides,
      },
    },
  };
}

test('valid signature: successful checkout marks payment paid and activates entitlement', async () => {
  const client = makeMockClient();
  const event = checkoutCompletedEvent();

  // Pre-create a pending payment (as if createCheckout had run)
  client._payments.set(PAYMENT_ID, {
    id: PAYMENT_ID,
    telegram_user_id: TELEGRAM_USER_ID,
    plan_id: 'monthly',
    stripe_checkout_session_id: CHECKOUT_SESSION_ID,
    status: 'pending',
    first_stripe_event_id: 'checkout_created',
    last_stripe_event_id: 'checkout_created',
  });

  const webhookService = buildWebhookService(client, event);
  const result = await webhookService.handleWebhook({
    rawBody: JSON.stringify(event),
    signature: 'valid-signature',
  });

  assert.equal(result.status, 'processed');

  // Payment should be marked paid
  const payment = client._payments.get(PAYMENT_ID);
  assert.equal(payment.status, 'paid');
  assert.equal(payment.stripe_payment_intent_id, 'pi_test_123');
  assert.equal(payment.stripe_customer_id, 'cus_test_123');

  // Entitlement should be activated
  const entitlement = client._entitlements.get(TELEGRAM_USER_ID);
  assert.equal(entitlement.status, 'active');
  assert.equal(entitlement.plan_id, 'monthly');
  assert.equal(entitlement.billing_status, 'active');
  assert.equal(entitlement.source_payment_id, PAYMENT_ID);

  // Server-side date calculation: starts now, expires 30 days later
  const expectedExpiry = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
  assert.equal(new Date(entitlement.starts_at).toISOString(), NOW.toISOString());
  assert.equal(new Date(entitlement.expires_at).toISOString(), expectedExpiry.toISOString());

  // stripe_events should have a processed record
  const eventRow = client._events.get(EVENT_ID);
  assert.equal(eventRow.status, 'processed');
});

test('invalid signature: returns signature_invalid without processing', async () => {
  const client = makeMockClient();
  const event = checkoutCompletedEvent();

  client._payments.set(PAYMENT_ID, {
    id: PAYMENT_ID,
    telegram_user_id: TELEGRAM_USER_ID,
    plan_id: 'monthly',
    stripe_checkout_session_id: CHECKOUT_SESSION_ID,
    status: 'pending',
    first_stripe_event_id: 'checkout_created',
    last_stripe_event_id: 'checkout_created',
  });

  const webhookService = buildWebhookService(client, event);
  const result = await webhookService.handleWebhook({
    rawBody: 'payload',
    signature: 'invalid-signature',
  });

  assert.equal(result.status, 'signature_invalid');

  // Payment should remain pending
  const payment = client._payments.get(PAYMENT_ID);
  assert.equal(payment.status, 'pending');

  // No entitlement should be created
  assert.equal(client._entitlements.size, 0);

  // No stripe_events record should exist
  assert.equal(client._events.size, 0);
});

test('duplicate event idempotent: second webhook for same event_id is not reprocessed', async () => {
  const client = makeMockClient();
  const event = checkoutCompletedEvent();

  client._payments.set(PAYMENT_ID, {
    id: PAYMENT_ID,
    telegram_user_id: TELEGRAM_USER_ID,
    plan_id: 'monthly',
    stripe_checkout_session_id: CHECKOUT_SESSION_ID,
    status: 'pending',
    first_stripe_event_id: 'checkout_created',
    last_stripe_event_id: 'checkout_created',
  });

  const webhookService = buildWebhookService(client, event);

  // First delivery — should process
  const first = await webhookService.handleWebhook({
    rawBody: JSON.stringify(event),
    signature: 'valid',
  });
  assert.equal(first.status, 'processed');

  // Second delivery of same event — should be duplicate
  const second = await webhookService.handleWebhook({
    rawBody: JSON.stringify(event),
    signature: 'valid',
  });
  assert.equal(second.status, 'duplicate');

  // Payment should still be paid (not double-processed)
  const payment = client._payments.get(PAYMENT_ID);
  assert.equal(payment.status, 'paid');
});

test('seven_day one-time payment activates entitlement with billing_status=paid', async () => {
  const client = makeMockClient();
  const event = checkoutCompletedEvent();
  event.data.object.subscription = null;

  client._payments.set(PAYMENT_ID, {
    id: PAYMENT_ID,
    telegram_user_id: TELEGRAM_USER_ID,
    plan_id: 'seven_day',
    stripe_checkout_session_id: CHECKOUT_SESSION_ID,
    status: 'pending',
    first_stripe_event_id: 'checkout_created',
    last_stripe_event_id: 'checkout_created',
  });

  const webhookService = buildWebhookService(client, event);
  await webhookService.handleWebhook({ rawBody: '{}', signature: 'valid' });

  const entitlement = client._entitlements.get(TELEGRAM_USER_ID);
  assert.equal(entitlement.plan_id, 'seven_day');
  assert.equal(entitlement.billing_status, 'paid');
  assert.equal(entitlement.status, 'active');

  // 7-day plan: expires 7 days from now
  const expectedExpiry = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
  assert.equal(new Date(entitlement.expires_at).toISOString(), expectedExpiry.toISOString());
});

test('yearly plan entitlement expires 365 days from now', async () => {
  const client = makeMockClient();
  const event = checkoutCompletedEvent();

  client._payments.set(PAYMENT_ID, {
    id: PAYMENT_ID,
    telegram_user_id: TELEGRAM_USER_ID,
    plan_id: 'yearly',
    stripe_checkout_session_id: CHECKOUT_SESSION_ID,
    status: 'pending',
    first_stripe_event_id: 'checkout_created',
    last_stripe_event_id: 'checkout_created',
  });

  const webhookService = buildWebhookService(client, event);
  await webhookService.handleWebhook({ rawBody: '{}', signature: 'valid' });

  const entitlement = client._entitlements.get(TELEGRAM_USER_ID);
  assert.equal(entitlement.plan_id, 'yearly');
  const expectedExpiry = new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000);
  assert.equal(new Date(entitlement.expires_at).toISOString(), expectedExpiry.toISOString());
});

test('checkout.session.expired marks payment as failed', async () => {
  const client = makeMockClient();
  const event = {
    id: 'evt_test_expired',
    type: 'checkout.session.expired',
    livemode: false,
    data: { object: { id: CHECKOUT_SESSION_ID } },
  };

  client._payments.set(PAYMENT_ID, {
    id: PAYMENT_ID,
    telegram_user_id: TELEGRAM_USER_ID,
    plan_id: 'monthly',
    stripe_checkout_session_id: CHECKOUT_SESSION_ID,
    status: 'pending',
    first_stripe_event_id: 'checkout_created',
    last_stripe_event_id: 'checkout_created',
  });

  const webhookService = buildWebhookService(client, event);
  const result = await webhookService.handleWebhook({ rawBody: '{}', signature: 'valid' });

  assert.equal(result.status, 'processed');
  assert.equal(result.event.action, 'payment_failed');

  const payment = client._payments.get(PAYMENT_ID);
  assert.equal(payment.status, 'failed');
  assert.equal(client._entitlements.size, 0);
});

test('unhandled event type is marked processed but ignored', async () => {
  const client = makeMockClient();
  const event = {
    id: 'evt_test_unhandled',
    type: 'customer.updated',
    livemode: false,
    data: { object: { id: 'cus_123' } },
  };

  const webhookService = buildWebhookService(client, event);
  const result = await webhookService.handleWebhook({ rawBody: '{}', signature: 'valid' });

  assert.equal(result.status, 'processed');
  assert.equal(result.event.action, 'ignored');
  assert.equal(client._payments.size, 0);
  assert.equal(client._entitlements.size, 0);
});

test('already-paid payment is not double-processed', async () => {
  const client = makeMockClient();
  const event = checkoutCompletedEvent();

  client._payments.set(PAYMENT_ID, {
    id: PAYMENT_ID,
    telegram_user_id: TELEGRAM_USER_ID,
    plan_id: 'monthly',
    stripe_checkout_session_id: CHECKOUT_SESSION_ID,
    status: 'paid',
    first_stripe_event_id: 'checkout_created',
    last_stripe_event_id: 'evt_previous',
  });

  const webhookService = buildWebhookService(client, event);
  const result = await webhookService.handleWebhook({ rawBody: '{}', signature: 'valid' });

  assert.equal(result.status, 'processed');
  assert.equal(result.event.action, 'ignored');
  assert.equal(result.event.reason, 'already_paid');
});

test('computePlanPeriod calculates correct durations for all plans', () => {
  const baseNow = new Date('2026-08-19T10:00:00.000Z');
  for (const planId of ['seven_day', 'monthly', 'yearly']) {
    const period = computePlanPeriod(planId, baseNow);
    const plan = PLANS[planId];
    const expectedExpiry = new Date(baseNow.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
    assert.equal(period.startsAt.toISOString(), baseNow.toISOString());
    assert.equal(period.expiresAt.toISOString(), expectedExpiry.toISOString());
  }
});
