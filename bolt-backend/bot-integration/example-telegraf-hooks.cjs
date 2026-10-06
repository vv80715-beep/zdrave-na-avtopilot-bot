'use strict';

// Integration example only. Adapt handler names to the current EliZdraveBot routes.
// The module intentionally does not add Telegraf as a website dependency.

const {
  createPurchaseReply,
  parseStartPayload,
  refreshAfterPayment,
  buildModeKeyboard,
  buildDeniedModeReply,
  buildPlanKeyboard,
  buildPlansOverviewText,
  buildStartReply,
} = require('./paymentFlow.cjs');

const PLAN_ACTIONS = Object.freeze({
  'buy:seven_day': 'seven_day',
  'buy:monthly': 'monthly',
  'buy:yearly': 'yearly',
});

function telegramUserIdFromContext(ctx) {
  return ctx?.from?.id == null ? '' : String(ctx.from.id);
}

async function safeAnswerCallback(ctx) {
  if (typeof ctx?.answerCbQuery !== 'function') return;
  try { await ctx.answerCbQuery(); } catch {}
}

async function localAccessFor(ctx, getLocalAccess) {
  if (typeof getLocalAccess !== 'function') return {};
  return (await getLocalAccess(ctx)) || {};
}

async function handlePlansCommand({ ctx, logger = console }) {
  try {
    await ctx.reply(buildPlansOverviewText(), {
      reply_markup: buildPlanKeyboard(),
    });
    return { handled: true };
  } catch (error) {
    logger.error?.('Failed to show plans:', { code: error?.code || error?.name });
    await ctx.reply('Не успях да покажа плановете. Опитай отново след малко.');
    return { handled: false };
  }
}

async function handleShowPlansCallback({ ctx, logger = console }) {
  await safeAnswerCallback(ctx);
  try {
    await ctx.reply(buildPlansOverviewText(), {
      reply_markup: buildPlanKeyboard(),
    });
    return { handled: true };
  } catch (error) {
    logger.error?.('Failed to show plans:', { code: error?.code || error?.name });
    await ctx.reply('Не успях да покажа плановете. Опитай отново след малко.');
    return { handled: false };
  }
}

function registerPurchaseActions({ bot, client, logger = console }) {
  if (!bot?.action || !client?.createPurchaseSession) {
    throw new Error('bot and EliPlatformClient are required.');
  }

  bot.action('show_plans', async (ctx) => {
    await handleShowPlansCallback({ ctx, logger });
  });

  for (const [action, planId] of Object.entries(PLAN_ACTIONS)) {
    bot.action(action, async (ctx) => {
      await safeAnswerCallback(ctx);
      try {
        const reply = await createPurchaseReply({
          client,
          telegramUserId: telegramUserIdFromContext(ctx),
          planId,
        });
        return ctx.reply(reply.text, { reply_markup: reply.replyMarkup });
      } catch (error) {
        logger.error?.('Failed to create Eli purchase link:', {
          code: error?.code || error?.name,
          retryable: Boolean(error?.retryable),
        });
        return ctx.reply('Не успях да създам защитен линк за плащане. Опитай отново след малко.');
      }
    });
  }
}

async function handleStartMessage({
  ctx,
  client,
  resolver,
  getLocalAccess = null,
}) {
  const parsed = parseStartPayload(ctx?.message?.text || '');
  const telegramUserId = telegramUserIdFromContext(ctx);

  if (parsed.type === 'buy_plan') {
    const reply = await createPurchaseReply({ client, telegramUserId, planId: parsed.planId });
    await ctx.reply(reply.text, { reply_markup: reply.replyMarkup });
    return { handled: true, type: parsed.type };
  }

  if (parsed.type === 'payment_complete') {
    const localAccess = await localAccessFor(ctx, getLocalAccess);
    const result = await refreshAfterPayment({ resolver, telegramUserId, localAccess });
    await ctx.reply(result.reply.text, {
      ...(result.reply.replyMarkup ? { reply_markup: result.reply.replyMarkup } : {}),
    });
    return { handled: true, type: parsed.type, access: result.access };
  }

  if (parsed.type === 'normal_start') {
    const reply = buildStartReply();
    await ctx.reply(reply.text, { reply_markup: reply.replyMarkup });
    return { handled: true, type: parsed.type };
  }

  return { handled: false, type: parsed.type };
}

function createModeGuard({
  resolver,
  mode,
  getLocalAccess = null,
  onDenied = null,
}) {
  if (!resolver?.checkMode) throw new Error('EntitlementResolver is required.');

  return async function modeGuard(ctx, next) {
    const localAccess = await localAccessFor(ctx, getLocalAccess);
    const decision = await resolver.checkMode(
      telegramUserIdFromContext(ctx),
      mode,
      localAccess,
    );

    if (!decision.allowed) {
      if (onDenied) return onDenied(ctx, decision);
      return ctx.reply(buildDeniedModeReply(decision, mode));
    }

    ctx.state = ctx.state || {};
    ctx.state.eliAccess = decision.access;
    return next();
  };
}

async function showModeMenu({ ctx, resolver, getLocalAccess = null, force = false }) {
  const localAccess = await localAccessFor(ctx, getLocalAccess);
  const access = await resolver.resolve(
    telegramUserIdFromContext(ctx),
    localAccess,
    { force },
  );
  const keyboard = buildModeKeyboard(access);

  if (!access.active || keyboard.inline_keyboard.length === 0) {
    await ctx.reply(buildDeniedModeReply({ access, code: access.reason }, 'text'));
    return access;
  }

  await ctx.reply('Избери как да говориш с Ели:', { reply_markup: keyboard });
  return access;
}

module.exports = {
  PLAN_ACTIONS,
  telegramUserIdFromContext,
  registerPurchaseActions,
  handleStartMessage,
  handlePlansCommand,
  handleShowPlansCallback,
  createModeGuard,
  showModeMenu,
};
