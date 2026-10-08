const { isOwner } = require('../adminGuard');
const { buildOwnerV22Context } = require('../brain/ownerV22Context');
const { formatOwnerPersonalMemory } = require('../brain/ownerMemorySummary');
const { formatFullMemory } = require('../memoryService');
const { replyWithMarkdownSafe } = require('../replyUtils');

function register(bot) {
  bot.command('showmemory', (ctx) => {
    if (ctx.session?.__scenes) ctx.session.__scenes = {};

    if (isOwner(ctx)) {
      return replyWithMarkdownSafe(
        ctx,
        formatOwnerPersonalMemory(buildOwnerV22Context(ctx.from.id))
      );
    }

    return replyWithMarkdownSafe(ctx, formatFullMemory(ctx.from.id));
  });
}

module.exports = { register };
