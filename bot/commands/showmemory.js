const { isOwner } = require('../adminGuard');
const { formatOwnerStoredSummary } = require('../brain/ownerGoalMemory');
const { formatFullMemory } = require('../memoryService');
const { replyWithMarkdownSafe } = require('../replyUtils');

function register(bot) {
  bot.command('showmemory', (ctx) => {
    if (ctx.session?.__scenes) ctx.session.__scenes = {};

    // Owner identity is a completely separate, permanent memory.
    if (isOwner(ctx)) {
      return replyWithMarkdownSafe(ctx, formatOwnerStoredSummary(ctx.from.id));
    }

    return replyWithMarkdownSafe(ctx, formatFullMemory(ctx.from.id));
  });
}

module.exports = { register };
