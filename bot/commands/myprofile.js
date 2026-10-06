const { getUser } = require('../storage');
const { FIELD_LABELS } = require('../constants');

function formatProfile(profile) {
  const val = (v, suffix = '') =>
    v !== null && v !== undefined ? `${v}${suffix}` : '—';

  const date = profile.createdAt
    ? new Date(profile.createdAt).toLocaleDateString('bg-BG')
    : '—';

  return (
    `👤 *Твоят профил*\n\n` +
    `🙍 Име: ${val(profile.firstName)}\n` +
    `🎂 Възраст: ${val(profile.age, ' год.')}\n` +
    `⚥ Пол: ${val(profile.gender)}\n` +
    `📏 Височина: ${val(profile.height, ' см')}\n` +
    `⚖️ Тегло: ${val(profile.weight, ' кг')}\n` +
    `🎯 Цел: ${val(profile.goal)}\n` +
    `⚡ Активност: ${val(profile.activityLevel)}\n` +
    `💪 Опит: ${val(profile.trainingExperience)}\n` +
    `🥗 Хранителни предпочитания: ${val(profile.foodPreferences)}\n` +
    `🩺 Медицински бележки: ${val(profile.medicalNotes)}\n\n` +
    `📅 Профилът е създаден на: ${date}`
  );
}

function register(bot) {
  bot.command('myprofile', async (ctx) => {
    const profile = getUser(ctx.from.id);
    if (!profile) {
      return ctx.reply(
        'Нямаш запазен профил. Използвай /profile за да създадеш един. 😊'
      );
    }
    await ctx.replyWithMarkdown(formatProfile(profile));
  });
}

module.exports = { register, formatProfile };
