'use strict';

const {
  EliPlatformClient,
  normalizeTelegramUserId,
} = require('./eliPlatformClient.cjs');
const {
  registerPurchaseActions,
  handleStartMessage,
  handlePlansCommand,
  telegramUserIdFromContext,
} = require('./example-telegraf-hooks.cjs');

const PURCHASE_FEATURE = 'eliPurchaseFlow';

function isFeatureRegistered(bot, feature) {
  return Boolean(bot?._eliRegisteredFeatures?.[feature]);
}

function markFeatureRegistered(bot, feature) {
  if (!bot) return;
  if (!bot._eliRegisteredFeatures) {
    Object.defineProperty(bot, '_eliRegisteredFeatures', {
      value: Object.create(null),
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  bot._eliRegisteredFeatures[feature] = true;
}

function resolveClient(clientOrEnv) {
  if (clientOrEnv && typeof clientOrEnv.createPurchaseSession === 'function') {
    return clientOrEnv;
  }
  if (clientOrEnv && (clientOrEnv.ELI_PLATFORM_BASE_URL || clientOrEnv.ELI_PURCHASE_API_BASE_URL)) {
    return EliPlatformClient.fromEnv(clientOrEnv);
  }
  throw new Error(
    'wirePurchaseFlow requires either an EliPlatformClient instance or an env object with ELI_PLATFORM_BASE_URL and BOT_PURCHASE_API_SECRET.',
  );
}

function verifyBackendConfig(client, logger) {
  if (!client?.baseUrl) {
    logger.warn?.('EliPlatformClient has no baseUrl — purchase sessions will fail.');
    return false;
  }
  if (!client?.internalSecret || String(client.internalSecret).trim().length < 32) {
    logger.warn?.('BOT_PURCHASE_API_SECRET is missing or too short — purchase sessions will be rejected.');
    return false;
  }
  return true;
}

function wirePurchaseFlow({
  bot,
  client = null,
  env = process.env,
  resolver = null,
  getLocalAccess = null,
  existingStartHandler = null,
  existingPlansHandler = null,
  logger = console,
} = {}) {
  if (!bot?.command || !bot?.action) {
    throw new Error('wirePurchaseFlow requires a Telegraf-compatible bot instance with .command() and .action().');
  }

  if (isFeatureRegistered(bot, PURCHASE_FEATURE)) {
    logger.info?.('Eli purchase flow already registered — skipping duplicate registration.');
    return { alreadyRegistered: true, client: null, configOk: false };
  }

  const platformClient = client ? resolveClient(client) : resolveClient(env);
  const configOk = verifyBackendConfig(platformClient, logger);

  registerPurchaseActions({ bot, client: platformClient, logger });

  bot.command('plans', async (ctx) => {
    if (existingPlansHandler) {
      await existingPlansHandler(ctx);
      return;
    }
    await handlePlansCommand({ ctx, logger });
  });

  bot.start(async (ctx, next) => {
    const result = await handleStartMessage({
      ctx,
      client: platformClient,
      resolver,
      getLocalAccess,
    });

    if (result.handled) return;

    if (typeof existingStartHandler === 'function') {
      return existingStartHandler(ctx);
    }

    if (typeof next === 'function') return next();
  });

  markFeatureRegistered(bot, PURCHASE_FEATURE);

  return { alreadyRegistered: false, client: platformClient, configOk };
}

module.exports = {
  wirePurchaseFlow,
  isFeatureRegistered,
  resolveClient,
  verifyBackendConfig,
  PURCHASE_FEATURE,
};
