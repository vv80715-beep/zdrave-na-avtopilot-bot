const { Markup } = require('telegraf');
const {
  EliPlatformClient,
  BoltPlatformError,
  CANONICAL_PLAN_IDS,
} = require('../boltPlatformClient');
const {
  planKeyboard,
  planDiscoveryKeyboard,
  PLANS_TEXT,
} = require('../planLinks');
const {
  clearEntitlementCache,
} = require('../entitlementResolver');
const {
  resolvePaymentCompleteStatus,
  communityUrl,
  PLAN_LABELS,
  MODE_LABELS,
} = require('../paymentComplete');

const registeredBots = new WeakSet();
const PURCHASE_ERROR_MESSAGE =
  'Не успях да създам сигурен линк за плащане. Моля, опитай отново след малко. 💙';

function purchaseFailureDiagnostic(error) {
  const isBoltError = error instanceof BoltPlatformError;
  const code = isBoltError ? error.code : null;
  let category = 'unknown';
  if (code === 'network_error' || code === 'timeout') category = 'network';
  else if (code === 'http_error') category = 'http';
  else if (
    code === 'invalid_json' ||
    code === 'invalid_response' ||
    code === 'invalid_purchase_response'
  ) {
    category = 'response-schema';
  } else if (
    code === 'invalid_plan' ||
    code === 'invalid_telegram_user_id' ||
    code === 'invalid_base_url' ||
    code === 'not_configured'
  ) {
    category = 'validation';
  }

  const errorClass = isBoltError
    ? 'BoltPlatformError'
    : ['Error', 'TypeError', 'AbortError'].includes(error?.name)
      ? error.name
      : 'UnknownError';
  return {
    status: isBoltError && Number.isInteger(error.status) ? error.status : null,
    code,
    errorClass,
    category,
  };
}

async function showPlans(ctx) {
  return ctx.reply(PLANS_TEXT, planKeyboard());
}

function startPayload(text) {
  const match = String(text || '').trim().match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/i);
  return match?.[1] || null;
}

async function refreshPaymentComplete(ctx, {
  clearCache = clearEntitlementCache,
  resolveStatus = resolvePaymentCompleteStatus,
  env = process.env,
} = {}) {
  const userId = String(ctx.from.id);
  clearCache(userId);
  const status = await resolveStatus(userId, { forceRefresh: true });
  if (status.active === true && status.backendVerified === true && status.state === 'paid') {
    const url = communityUrl(env);
    const message =
      'Готово — плащането е потвърдено и планът ти е активен. ✅\n\n' +
      `Активен план: ${PLAN_LABELS[status.plan] || status.plan}\n` +
      `Режими: ${status.allowedModes.map((mode) => MODE_LABELS[mode]).filter(Boolean).join(', ')}` +
      (url ? '' : '\n\nЛинкът към Общността не е конфигуриран с валиден HTTPS адрес.');
    await ctx.reply(
      message,
      url ? Markup.inlineKeyboard([
        [Markup.button.url('Отвори Общността ↗', url)],
      ]) : undefined
    );
    return status;
  }
  await ctx.reply(
    'Плащането още не е потвърдено от backend-а. Premium достъп не е отключен от тази проверка. Опитай /start payment_complete отново след малко.',
    planDiscoveryKeyboard()
  );
  return status;
}

const PRIVATE_PURCHASE_MESSAGE = 'Отвори бота в личен чат, за да купиш план. 💙';

async function sendPurchaseLink(ctx, planId, client) {
  if (!ctx.from || !ctx.chat || ctx.chat.id !== ctx.from.id || ctx.chat.type !== 'private') {
    return ctx.reply(PRIVATE_PURCHASE_MESSAGE);
  }
  if (!CANONICAL_PLAN_IDS.has(planId)) {
    return ctx.reply('Невалиден план. Виж /plans.');
  }
  try {
    // Never accept an identity from a payload or callback; the client validates
    // the backend response and the confirmation URL before it is sent.
    const purchase = await client.createPurchaseSession(String(ctx.from.id), planId);
    return ctx.reply(
      `Сигурният ти линк за план „${purchase.plan.name}" е готов:`,
      Markup.inlineKeyboard([
        [Markup.button.url('Confirm payment', purchase.purchase_url)],
      ])
    );
  } catch (error) {
    // Never log the request, response, purchase URL, credentials or error text.
    console.warn('Bolt purchase-session request failed', purchaseFailureDiagnostic(error));
    return ctx.reply(PURCHASE_ERROR_MESSAGE);
  }
}

function register(bot, { client = new EliPlatformClient() } = {}) {
  if (registeredBots.has(bot)) return false;
  registeredBots.add(bot);

  bot.command('plans', showPlans);
  bot.action('show_plans', async (ctx) => {
    await ctx.answerCbQuery();
    await showPlans(ctx);
  });

  for (const planId of CANONICAL_PLAN_IDS) {
    bot.action(`buy:${planId}`, async (ctx) => {
      await ctx.answerCbQuery();
      return sendPurchaseLink(ctx, planId, client);
    });
  }
  return true;
}

module.exports = {
  register,
  showPlans,
  startPayload,
  refreshPaymentComplete,
  sendPurchaseLink,
  PRIVATE_PURCHASE_MESSAGE,
  PURCHASE_ERROR_MESSAGE,
  purchaseFailureDiagnostic,
};