const { isOwner } = require('../adminGuard');

function register(bot) {
  bot.command('whoami', (ctx) => {
    // Exit any active scene so this command always works
    if (ctx.session?.__scenes) ctx.session.__scenes = {};

    const { id, first_name, username } = ctx.from;
    const owner = isOwner(ctx);

    const lines = [
      `🪪 *Твоите данни*\n`,
      `🆔 Telegram ID: \`${id}\``,
      `👤 Първо ime: ${first_name}`,
      username ? `🔖 Username: @${username}` : `🔖 Username: не е зададен`,
      owner ? `\n👑 Роля: Собственик и създател` : `\n🙍 Роля: Потребител`,
    ];

    ctx.replyWithMarkdown(lines.join('\n'));
  });
}

module.exports = { register };
