'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPlanKeyboard,
  parsePlanCallbackData,
  parseStartPayload,
  createPurchaseReply,
  buildPaymentCompleteReply,
  buildModeKeyboard,
  buildDeniedModeReply,
  refreshAfterPayment,
} = require('../paymentFlow.cjs');

test('plan keyboard exposes only the three canonical plans', () => {
  const keyboard = buildPlanKeyboard();
  assert.deepEqual(
    keyboard.inline_keyboard.flat().map((button) => button.callback_data),
    ['buy:seven_day', 'buy:monthly', 'buy:yearly'],
  );
});

test('plan callbacks and Telegram deep-link payloads parse deterministically', () => {
  assert.equal(parsePlanCallbackData('buy:monthly'), 'monthly');
  assert.equal(parsePlanCallbackData('buy_yearly'), 'yearly');
  assert.equal(parsePlanCallbackData('buy:vip'), null);
  assert.deepEqual(parseStartPayload('/start payment_complete'), { type: 'payment_complete' });
  assert.deepEqual(parseStartPayload('/start buy_seven_day'), { type: 'buy_plan', planId: 'seven_day' });
  assert.deepEqual(parseStartPayload('/start'), { type: 'normal_start' });
});

test('purchase reply uses only the server-generated URL and never exposes Telegram ID', async () => {
  const purchaseUrl = `https://eli.example/confirm-plan.html?session=${'A'.repeat(43)}`;
  const reply = await createPurchaseReply({
    client: {
      createPurchaseSession: async ({ telegramUserId, planId }) => {
        assert.equal(telegramUserId, '8934490753');
        assert.equal(planId, 'monthly');
        return {
          purchaseUrl,
          expiresAt: new Date('2026-08-19T10:00:00.000Z'),
          plan: { id: 'monthly', name: '1 месец с Ели' },
        };
      },
    },
    telegramUserId: '8934490753',
    planId: 'monthly',
  });

  assert.equal(reply.replyMarkup.inline_keyboard[0][0].url, purchaseUrl);
  assert.equal(reply.replyMarkup.inline_keyboard[0][0].url.includes('8934490753'), false);
  assert.match(reply.text, /самият линк не активира Premium/i);
});

test('payment-complete message unlocks only a backend-verified active entitlement', () => {
  const active = buildPaymentCompleteReply({
    active: true,
    paid: true,
    backendVerified: true,
    chatModes: ['text', 'voice', 'avatar'],
    expiresAt: new Date('2026-09-19T09:00:00.000Z'),
  });
  assert.equal(active.active, true);
  assert.match(active.text, /потвърдено/);
  assert.match(active.text, /Avatar видео/);
  assert.deepEqual(
    active.replyMarkup.inline_keyboard.flat().map((button) => button.callback_data),
    ['mode:text', 'mode:voice', 'mode:avatar'],
  );

  const stale = buildPaymentCompleteReply({
    active: true,
    paid: true,
    backendVerified: false,
    chatModes: ['text'],
  });
  assert.equal(stale.active, false);
  assert.match(stale.text, /още не е потвърдено/);
});

test('mode keyboard is generated only from effective allowed chat modes', () => {
  const keyboard = buildModeKeyboard({ chatModes: ['text', 'avatar'] });
  assert.deepEqual(
    keyboard.inline_keyboard.flat().map((button) => button.callback_data),
    ['mode:text', 'mode:avatar'],
  );
});

test('denied mode replies explain fail-closed and expired cases', () => {
  assert.match(
    buildDeniedModeReply({ code: 'paid_verification_unavailable' }, 'avatar'),
    /не стартирам платена заявка/i,
  );
  assert.match(
    buildDeniedModeReply({ code: 'paid_access_inactive' }, 'voice'),
    /план е изтекъл/i,
  );
  assert.match(
    buildDeniedModeReply({ code: 'mode_not_in_plan' }, 'avatar'),
    /не включва режим/i,
  );
});

test('refreshAfterPayment forces resolver refresh before announcing activation', async () => {
  let calls = 0;
  const result = await refreshAfterPayment({
    resolver: {
      refreshAfterPayment: async (userId, localAccess) => {
        calls += 1;
        assert.equal(userId, '8934490753');
        assert.equal(localAccess.state, 'trial');
        return {
          active: true,
          paid: true,
          backendVerified: true,
          chatModes: ['text', 'voice'],
          expiresAt: new Date('2026-08-26T09:00:00.000Z'),
        };
      },
    },
    telegramUserId: '8934490753',
    localAccess: { state: 'trial' },
  });
  assert.equal(calls, 1);
  assert.equal(result.reply.active, true);
});
