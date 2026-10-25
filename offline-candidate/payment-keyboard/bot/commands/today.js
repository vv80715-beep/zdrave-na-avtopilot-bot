const { getTodayCheckin, todayKey } = require('../checkinStorage');
const { getUser } = require('../storage');

function formatCheckin(entry, name) {
  const yn = (v) => (v ? '✅ Да' : '❌ Не');
  const mood = entry.mood;
  const energy = entry.energy;
  const moodBar = '⭐'.repeat(Math.round(mood / 2));
  const energyBar = '⚡'.repeat(Math.round(energy / 2));

  return (
    `📋 *Дневен check-in${name ? ` — ${name}` : ''}*\n` +
    `📅 ${todayKey()}\n\n` +
    `💧 Достатъчно вода: ${yn(entry.water)}\n` +
    `🏋️ Тренировка: ${yn(entry.trained)}\n` +
    `🥗 Хранене според целта: ${yn(entry.nutrition)}\n` +
    `😴 Часове сън: ${entry.sleep} ч.\n` +
    `😊 Настроение: ${mood}/10 ${moodBar}\n` +
    `⚡ Енергия: ${energy}/10 ${energyBar}`
  );
}

function register(bot) {
  bot.command('today', async (ctx) => {
    const entry = getTodayCheckin(ctx.from.id);
    if (!entry) {
      return ctx.reply(
        'Нямаш check-in за днес. Използвай /checkin за да направиш своя дневен запис. 😊'
      );
    }
    const profile = getUser(ctx.from.id);
    await ctx.replyWithMarkdown(formatCheckin(entry, profile?.firstName));
  });
}

module.exports = { register, formatCheckin };
