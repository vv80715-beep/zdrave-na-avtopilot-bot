const { isOwner } = require('../adminGuard');
const { formatOwnerStoredSummary } = require('../brain/ownerGoalMemory');
const { formatFullMemory } = require('../memoryService');
const { replyWithMarkdownSafe } = require('../replyUtils');
const { getUniversalMemoryRuntime } = require('../brain/universal/runtime');

function register(bot) {
  bot.command('showmemory', async (ctx) => {
    if (ctx.session?.__scenes) ctx.session.__scenes = {};
    const universal = getUniversalMemoryRuntime();
    if (universal.active(ctx.from.id)) return replyWithMarkdownSafe(ctx, await universal.show(ctx));

    // Owner identity is a completely separate, permanent memory.
    if (isOwner(ctx)) {
      return replyWithMarkdownSafe(ctx, formatOwnerStoredSummary(ctx.from.id));
    }

    return replyWithMarkdownSafe(ctx, formatFullMemory(ctx.from.id));
  });
}

module.exports = { register };

