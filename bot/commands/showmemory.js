const { isOwner } = require('../adminGuard');
const { OWNER_NAME, OWNER_MEMORY } = require('../ownerContext');
const { formatFullMemory } = require('../memoryService');
const { replyWithMarkdownSafe } = require('../replyUtils');

function register(bot) {
  bot.command('showmemory', (ctx) => {
    if (ctx.session?.__scenes) ctx.session.__scenes = {};

    // Owner identity is a completely separate, permanent memory.
    if (isOwner(ctx)) {
      return replyWithMarkdownSafe(
        ctx,
        `🧠 *Памет за собственика (${OWNER_NAME})*\n\n` +
        `Това е отделна и постоянна идентичност, която винаги помня:\n\n` +
        OWNER_MEMORY
      );
    }

    return replyWithMarkdownSafe(ctx, formatFullMemory(ctx.from.id));
  });
}

module.exports = { register };
