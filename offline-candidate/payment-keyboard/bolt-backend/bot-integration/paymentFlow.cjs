'use strict';

const { normalizePlanId, normalizeTelegramUserId, normalizeMode } = require('./eliPlatformClient.cjs');

const PLAN_BUTTONS = Object.freeze([
  Object.freeze({ planId: 'seven_day', text: '7 дни — €15' }),
  Object.freeze({ planId: 'monthly', text: '1 месец — €50' }),
  Object.freeze({ planId: 'yearly', text: '1 година — €360' }),
]);

function buildPlanKeyboard() {
  return {
    inline_keyboard: PLAN_BUTTONS.map(({ planId, text }) => ([{
      text,
      callback_data: `buy:${planId}`,
    }])),
  };
}

function buildPlansOverviewText() {
  return [
    'Избери план за пълен достъп до Ели:',
    '',
    ...PLAN_BUTTONS.map(({ text }) => `• ${text}`),
    '',
    'Натисни бутона, за да получиш защитен линк за покупка. Самият линк не активира Premium — достъпът се отключва само след проверено плащане.',
  ].join('\n');
}

function buildStartReply() {
  return {
    text: [
      'Здравей! Аз съм Ели — твоят личен AI здравен асистент.',
      '',
      'Мога да ти помагам с навици, ежедневна подкрепа и ясни следващи стъпки.',
      '',
      'Започни с 5 дни безплатно или избери план за пълен достъп:',
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        [{ text: 'Започни 5 дни безплатно', url: 'https://t.me/EliZdraveBot?start=trial' }],
        [{ text: 'Планове и абонамент', callback_data: 'show_plans' }],
      ],
    },
  };
}

function parsePlanCallbackData(value) {
  const raw = String(value || '').trim();
  const match = /^(?:buy:|buy_|plan:|plan_)(seven_day|monthly|yearly)$/.exec(raw);
  return match ? normalizePlanId(match[1]) : null;
}

function parseStartPayload(text) {
  const raw = String(text || '').trim();
  const match = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]{1,64}))?$/i.exec(raw);
  const payload = match?.[1] || '';
  if (payload === 'payment_complete') return { type: 'payment_complete' };
  const planMatch = /^buy_(seven_day|monthly|yearly)$/.exec(payload);
  if (planMatch) return { type: 'buy_plan', planId: planMatch[1] };
  return payload ? { type: 'unknown', payload } : { type: 'normal_start' };
}

function formatBulgarianDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'скоро';
  return new Intl.DateTimeFormat('bg-BG', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Sofia',
  }).format(date);
}

function planLabel(planId) {
  return {
    seven_day: '7-дневния план',
    monthly: 'месечния план',
    yearly: 'годишния план',
  }[planId] || 'избрания план';
}

async function createPurchaseReply({ client, telegramUserId, planId }) {
  if (!client?.createPurchaseSession) throw new Error('createPurchaseReply requires an EliPlatformClient.');
  const userId = normalizeTelegramUserId(telegramUserId);
  const canonicalPlanId = normalizePlanId(planId);
  if (!userId || !canonicalPlanId) throw new Error('Invalid Telegram user or plan.');

  const session = await client.createPurchaseSession({
    telegramUserId: userId,
    planId: canonicalPlanId,
  });

  return {
    text: [
      `Подготвих защитен линк за ${planLabel(canonicalPlanId)}.`,
      '',
      `Линкът е валиден до ${formatBulgarianDate(session.expiresAt)}. Самият линк не активира Premium — достъпът се отключва само след проверено плащане.`,
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [[{
        text: 'Продължи към сигурно плащане ↗',
        url: session.purchaseUrl,
      }]],
    },
    purchaseUrl: session.purchaseUrl,
    expiresAt: session.expiresAt,
    plan: session.plan,
  };
}

function buildPaymentCompleteReply(access) {
  if (!access?.active || !access?.paid || !access?.backendVerified) {
    return {
      active: false,
      text: [
        'Плащането още не е потвърдено от backend-а.',
        'Изчакай малко и използвай /mode отново. Връщането от Stripe само по себе си не отключва Premium.',
      ].join('\n'),
      replyMarkup: null,
    };
  }

  const modeLabels = access.chatModes.map((mode) => ({
    text: 'текст',
    voice: 'глас',
    avatar: 'Avatar видео',
  }[mode] || mode));

  return {
    active: true,
    text: [
      'Готово — плащането е потвърдено и планът ти е активен. ✅',
      `Достъп: ${modeLabels.join(', ') || 'Premium'}.`,
      access.expiresAt ? `Активен до: ${formatBulgarianDate(access.expiresAt)}.` : '',
      'Използвай /mode, за да избереш как да говориш с Ели.',
    ].filter(Boolean).join('\n'),
    replyMarkup: buildModeKeyboard(access),
  };
}

function buildModeKeyboard(access) {
  const buttons = [];
  if (access?.chatModes?.includes('text')) buttons.push([{ text: 'Пиши с Ели', callback_data: 'mode:text' }]);
  if (access?.chatModes?.includes('voice')) buttons.push([{ text: 'Говори с Ели', callback_data: 'mode:voice' }]);
  if (access?.chatModes?.includes('avatar')) buttons.push([{ text: 'Говори с аватара на Ели', callback_data: 'mode:avatar' }]);
  return { inline_keyboard: buttons };
}

function buildDeniedModeReply(decision, requestedMode) {
  const mode = normalizeMode(requestedMode);
  const modeName = { text: 'текст', voice: 'глас', avatar: 'Avatar' }[mode] || 'този режим';
  const code = decision?.code || decision?.access?.reason || 'access_inactive';

  if (['paid_verification_required', 'paid_verification_unavailable'].includes(code)) {
    return 'В момента не мога сигурно да потвърдя платения ти достъп. Не стартирам платена заявка, за да няма грешно начисляване. Опитай отново след малко.';
  }
  if (['paid_access_inactive', 'no_second_trial_after_paid'].includes(code)) {
    return 'Платеният ти план е изтекъл. Профилът и прогресът ти са запазени, но Premium заявките остават заключени до ново потвърдено плащане.';
  }
  if (code === 'mode_not_in_plan') {
    return `Активният ти план не включва режим „${modeName}“. Останалите разрешени функции продължават да работят.`;
  }
  if (code === 'backend_temporarily_unavailable_local_trial_only') {
    return 'В момента е достъпен само текстовият Free Trial режим. Платените функции изискват нова server-side проверка.';
  }
  return 'Нямаш активен достъп до този режим. Избери план или провери статуса си с /mode.';
}

async function refreshAfterPayment({ resolver, telegramUserId, localAccess = {} }) {
  if (!resolver?.refreshAfterPayment) throw new Error('refreshAfterPayment requires an EntitlementResolver.');
  const userId = normalizeTelegramUserId(telegramUserId);
  if (!userId) throw new Error('Invalid Telegram user ID.');
  const access = await resolver.refreshAfterPayment(userId, localAccess);
  return { access, reply: buildPaymentCompleteReply(access) };
}

module.exports = {
  PLAN_BUTTONS,
  buildPlanKeyboard,
  buildPlansOverviewText,
  buildStartReply,
  parsePlanCallbackData,
  parseStartPayload,
  formatBulgarianDate,
  createPurchaseReply,
  buildPaymentCompleteReply,
  buildModeKeyboard,
  buildDeniedModeReply,
  refreshAfterPayment,
};
