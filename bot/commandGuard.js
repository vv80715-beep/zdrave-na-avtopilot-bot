// Pure matcher for command-looking text. Telegraf's bot.command() only fires
// when Telegram attaches a `bot_command` entity at offset 0; text that LOOKS
// like a command but arrives without that entity (leading space, forwarded or
// copied text, voice transcripts, some clients) would otherwise fall through
// to the generic AI handler. Commands must NEVER reach the AI.
//
// Returns null when the text is not command-like (normal conversation —
// mid-text slashes, URLs, fractions like "1/2 литра" never match because the
// pattern is anchored to the start after trimming).
// Otherwise returns { cmd, target, ours }:
//   cmd    — lowercase command name without the slash
//   target — the @botname suffix if present (without @), else undefined
//   ours   — false only when the command is explicitly addressed to another bot
function parseCommandText(text, botUsername) {
  const m = (text || '').trim().match(/^\/([A-Za-z0-9_]+)(?:@(\S+))?/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const target = m[2];
  const ours =
    !target ||
    !botUsername ||
    target.toLowerCase() === botUsername.toLowerCase();
  return { cmd, target, ours };
}

module.exports = { parseCommandText };
