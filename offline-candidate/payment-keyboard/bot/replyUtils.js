// Telegram's legacy Markdown parser rejects a whole message when its dynamic
// content contains stray *, _, ` or [ characters (e.g. a user's name, allergy
// or medical note). This helper tries Markdown first and transparently falls
// back to plain text so profile/memory retrieval never fails for such users.
const { stripLookTags } = require('./avatarLooks');

async function replyWithMarkdownSafe(ctx, rawText) {
  // Defense in depth: the internal [LOOK:...] service tag must never reach a
  // user — even echoed back from stored user-controlled data.
  const text = stripLookTags(rawText);
  try {
    await ctx.replyWithMarkdown(text);
  } catch (err) {
    if (/parse|entit/i.test(err?.message || '')) {
      await ctx.reply(text.replace(/[*_`]/g, ''));
    } else {
      throw err;
    }
  }
}

module.exports = { replyWithMarkdownSafe };
