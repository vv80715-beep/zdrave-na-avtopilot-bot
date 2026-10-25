const { isOwner } = require('../adminGuard');
const { buildOwnerV22Context } = require('../brain/ownerV22Context');
const { formatOwnerPersonalMemory } = require('../brain/ownerMemorySummary');
const { formatOwnerDossierSummary } = require('../ownerDossier');
const { formatFullMemory } = require('../memoryService');
const { replyWithMarkdownSafe } = require('../replyUtils');

function register(bot, dependencies = {}) {
  const ownerCheck = dependencies.isOwner || isOwner;
  const buildOwnerContext = dependencies.buildOwnerV22Context || buildOwnerV22Context;
  const formatOwnerMemory = dependencies.formatOwnerPersonalMemory || formatOwnerPersonalMemory;
  const formatDossier = dependencies.formatOwnerDossierSummary || formatOwnerDossierSummary;
  const formatLegacyMemory = dependencies.formatFullMemory || formatFullMemory;
  const reply = dependencies.replyWithMarkdownSafe || replyWithMarkdownSafe;

  bot.command('showmemory', (ctx) => {
    if (ctx.session?.__scenes) ctx.session.__scenes = {};

    if (ownerCheck(ctx)) {
      return reply(ctx, [
        formatOwnerMemory(buildOwnerContext(ctx.from.id)),
        formatDossier(ctx.from.id),
      ].filter(Boolean).join('\n\n'));
    }

    return reply(ctx, formatLegacyMemory(ctx.from.id));
  });
}

module.exports = { register };
