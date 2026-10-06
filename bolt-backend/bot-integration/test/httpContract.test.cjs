'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRequestHandler } = require('../../server/app');
const {
  PurchaseSessionService,
  MemoryPurchaseSessionStore,
} = require('../../server/purchaseSessionService');
const { withHandler } = require('../../server/test/testHelpers');
const { EliPlatformClient } = require('../eliPlatformClient.cjs');

const INTERNAL_SECRET = 'bridge-http-contract-secret-1234567890';

test('bot bridge works against the real internal HTTP contract', async () => {
  const now = () => new Date('2026-08-19T10:00:00.000Z');
  const service = new PurchaseSessionService({
    store: new MemoryPurchaseSessionStore({ now }),
    now,
    ttlMinutes: 15,
  });

  const billingService = {
    async getInternalEntitlement(telegramUserId) {
      return {
        telegram_user_id: telegramUserId,
        active: true,
        plan_id: 'monthly',
        plan: {
          id: 'monthly',
          name: '1 месец с Ели',
          price: { amount: 50, currency: 'EUR', display: '€50' },
        },
        status: 'active',
        billing_status: 'active',
        modes: ['text', 'voice', 'avatar', 'community'],
        avatar_minutes_per_month: 30,
        starts_at: '2026-08-19T10:00:00.000Z',
        current_period_start: '2026-08-19T10:00:00.000Z',
        current_period_end: '2026-09-19T10:00:00.000Z',
        expires_at: '2026-09-19T10:00:00.000Z',
        cancel_at_period_end: false,
        stripe_subscription_id: 'sub_test_bridge',
      };
    },
  };

  const handler = createRequestHandler({
    service,
    billingService,
    internalSecret: INTERNAL_SECRET,
    appBaseUrl: '',
    storageKind: 'memory',
    readinessCheck: async () => ({ ok: true }),
  });

  await withHandler(handler, async (baseUrl) => {
    const client = new EliPlatformClient({
      baseUrl,
      internalSecret: INTERNAL_SECRET,
      production: false,
    });

    const purchase = await client.createPurchaseSession({
      telegramUserId: '8934490753',
      planId: 'monthly',
    });
    const purchaseUrl = new URL(purchase.purchaseUrl);
    assert.equal(purchaseUrl.origin, baseUrl);
    assert.equal(purchaseUrl.pathname, '/confirm-plan.html');
    assert.equal(purchaseUrl.searchParams.has('telegram_user_id'), false);
    assert.equal(purchase.plan.id, 'monthly');

    const entitlement = await client.getEntitlement('8934490753');
    assert.equal(entitlement.active, true);
    assert.equal(entitlement.planId, 'monthly');
    assert.deepEqual(entitlement.modes, ['text', 'voice', 'avatar', 'community']);
    assert.equal(entitlement.avatarMinutesPerMonth, 30);
  });
});
