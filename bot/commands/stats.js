const { getAllCheckins } = require('../checkinStorage');
const { getUser } = require('../storage');

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function register(bot) {
  bot.command('stats', async (ctx) => {
    const all = getAllCheckins(ctx.from.id);
    if (all.length === 0) {
      return ctx.reply(
        'Нямаш записи все още. Направи /checkin за да започнеш да събираш статистика. 😊'
      );
    }

    const profile = getUser(ctx.from.id);
    const name = profile?.firstName ? `, ${profile.firstName}` : '';

    const total = all.length;
    const trainedDays = all.filter((e) => e.trained).length;
    const waterDays = all.filter((e) => e.water).length;
    const nutritionDays = all.filter((e) => e.nutrition).length;
    const avgSleep = round1(avg(all.map((e) => e.sleep)));
    const avgMood = round1(avg(all.map((e) => e.mood)));
    const avgEnergy = round1(avg(all.map((e) => e.energy)));

    const trainPct = Math.round((trainedDays / total) * 100);
    const waterPct = Math.round((waterDays / total) * 100);
    const nutritionPct = Math.round((nutritionDays / total) * 100);

    const moodBar = '⭐'.repeat(Math.round(avgMood / 2));
    const energyBar = '⚡'.repeat(Math.round(avgEnergy / 2));

    const msg =
      `📈 *Твоята статистика${name}*\n` +
      `Базирана на ${total} check-ина\n\n` +
      `🏋️ Дни с тренировка: ${trainedDays}/${total} (${trainPct}%)\n` +
      `💧 Дни с достатъчно вода: ${waterDays}/${total} (${waterPct}%)\n` +
      `🥗 Дни с правилно хранене: ${nutritionDays}/${total} (${nutritionPct}%)\n` +
      `😴 Среден сън: ${avgSleep} ч.\n` +
      `😊 Средно настроение: ${avgMood}/10 ${moodBar}\n` +
      `⚡ Средна енергия: ${avgEnergy}/10 ${energyBar}\n\n` +
      buildMotivation(trainPct, waterPct, avgSleep, avgMood);

    await ctx.replyWithMarkdown(msg);
  });
}

function buildMotivation(trainPct, waterPct, avgSleep, avgMood) {
  const tips = [];
  if (trainPct < 50) tips.push('💡 Опитай да добавиш още една тренировка на седмица — дори 20 минути броят!');
  if (waterPct < 70) tips.push('💡 Хидратацията е ключова — постави си напомняне на всеки 2 часа да пиеш вода.');
  if (avgSleep < 7) tips.push('💡 Средният сън е под 7 часа. Лягай 30 минути по-рано тази вечер.');
  if (avgMood < 5) tips.push('💡 Настроението е малко ниско. Кратка разходка навън може да помогне много!');
  if (tips.length === 0) return '🎉 Страхотен напредък! Продължавай в същия дух!';
  return tips.join('\n');
}

module.exports = { register };
