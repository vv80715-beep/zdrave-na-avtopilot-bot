const { getHistory } = require('../checkinStorage');
const { getUser } = require('../storage');

function formatDay(entry) {
  const yn = (v) => (v ? '✅' : '❌');
  return (
    `📅 *${entry.date}*\n` +
    `💧 Вода: ${yn(entry.water)}  🏋️ Трениране: ${yn(entry.trained)}  🥗 Хранене: ${yn(entry.nutrition)}\n` +
    `😴 Сън: ${entry.sleep}ч  😊 Настроение: ${entry.mood}/10  ⚡ Енергия: ${entry.energy}/10`
  );
}

function register(bot) {
  bot.command('history', async (ctx) => {
    const history = getHistory(ctx.from.id, 7);
    if (history.length === 0) {
      return ctx.reply(
        'Нямаш записи все още. Използвай /checkin за да започнеш да следиш навиците си. 😊'
      );
    }

    const profile = getUser(ctx.from.id);
    const name = profile?.firstName ? `, ${profile.firstName}` : '';

    const header = `📊 *Последните 7 check-ина${name}*\n\n`;
    const body = history.map(formatDay).join('\n\n');

    await ctx.replyWithMarkdown(header + body);
  });
}

module.exports = { register };
