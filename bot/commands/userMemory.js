const fs = require('fs');
const path = require('path');
const { isOwner } = require('../adminGuard');
const { formatFullMemory } = require('../memoryService');
const { getUser } = require('../storage');
const { getUniversalMemoryRuntime } = require('../brain/universal/runtime');

const USERS_PATH = path.join(__dirname, '..', 'users.json');
const MEMORY_PATH = path.join(__dirname, '..', 'user_memory.json');
const CHECKINS_PATH = path.join(__dirname, '..', 'daily_progress.json');

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function register(bot) {
  // List all known user IDs (owner only) so the owner knows what to inspect.
  bot.command('users', (ctx) => {
    if (ctx.session?.__scenes) ctx.session.__scenes = {};
    if (!isOwner(ctx)) {
      return ctx.reply('Нямаш достъп до тази команда.');
    }

    const ids = new Set([
      ...Object.keys(loadJson(USERS_PATH)),
      ...Object.keys(loadJson(MEMORY_PATH)),
      ...Object.keys(loadJson(CHECKINS_PATH)),
    ]);

    if (ids.size === 0) {
      return ctx.reply('Все още няма потребители.');
    }

    const lines = ['👥 *Известни потребители*\n'];
    for (const id of ids) {
      const profile = getUser(id);
      const name = profile?.firstName ? ` — ${profile.firstName}` : '';
      lines.push(`• \`${id}\`${name}`);
    }
    lines.push('\nИзползвай /usermemory <id> за да видиш паметта на конкретен потребител.');

    ctx.replyWithMarkdown(lines.join('\n'));
  });

  // Inspect any user's memory (owner only).
  bot.command('usermemory', async (ctx) => {
    if (ctx.session?.__scenes) ctx.session.__scenes = {};
    if (!isOwner(ctx)) {
      return ctx.reply('Нямаш достъп до тази команда.');
    }

    const arg = ctx.message.text.split(/\s+/)[1];
    if (!arg) {
      return ctx.reply(
        'Използване: /usermemory <telegram_id>\n\nВиж списък с ID-та чрез /users.'
      );
    }

    const universal = getUniversalMemoryRuntime();
    if (universal.active(arg)) {
      if (String(ctx.from.id) === arg) return ctx.reply(await universal.show(ctx));
      return ctx.reply('Новата лична памет се показва на самия потребител с /showmemory в личния чат.');
    }

    ctx.replyWithMarkdown(formatFullMemory(arg, { admin: true }));
  });
}

module.exports = { register };

