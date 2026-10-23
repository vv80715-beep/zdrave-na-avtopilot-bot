'use strict';

async function restoreDefaultMenuButton(telegram, logger = console) {
  if (!telegram || typeof telegram.getChatMenuButton !== 'function' ||
      typeof telegram.setChatMenuButton !== 'function') {
    logger.warn('Telegram menu state unavailable; verify the menu manually.');
    return { ok: false, reason: 'menu_api_unavailable' };
  }

  try {
    const menu = await telegram.getChatMenuButton();
    if (menu?.type !== 'web_app') {
      const type = menu?.type || 'unknown';
      logger.log(`Telegram menu already uses ${type}; no change needed.`);
      return { ok: true, changed: false, type };
    }

    await telegram.setChatMenuButton({ menuButton: { type: 'default' } });
    const verified = await telegram.getChatMenuButton();
    if (verified?.type !== 'default') {
      logger.warn('Telegram menu reset could not be verified; check BotFather settings.');
      return { ok: false, reason: 'menu_reset_unverified' };
    }

    logger.log('Telegram Mini App menu entry removed; default chat menu restored.');
    return { ok: true, changed: true, type: verified.type };
  } catch {
    logger.warn('Telegram menu reset failed; check BotFather settings manually.');
    return { ok: false, reason: 'menu_reset_failed' };
  }
}

module.exports = { restoreDefaultMenuButton };
