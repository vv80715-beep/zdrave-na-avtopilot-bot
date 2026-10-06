const OWNER_ID = process.env.OWNER_TELEGRAM_ID
  ? String(process.env.OWNER_TELEGRAM_ID).trim()
  : null;

function isOwner(ctx) {
  if (!OWNER_ID) return false;
  return String(ctx.from?.id) === OWNER_ID;
}

function isOwnerId(userId) {
  if (!OWNER_ID) return false;
  return String(userId) === OWNER_ID;
}

function ownerOnly(handler) {
  return async (ctx) => {
    if (!isOwner(ctx)) {
      return ctx.reply('Нямаш достъп до тази команда.');
    }
    return handler(ctx);
  };
}

module.exports = { isOwner, isOwnerId, ownerOnly };
