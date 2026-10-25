const fs = require('fs');
const path = require('path');
const { isOwner } = require('../adminGuard');

const USERS_PATH = path.join(__dirname, '..', 'users.json');
const CHECKINS_PATH = path.join(__dirname, '..', 'daily_progress.json');

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function getAdminStats() {
  const profiles = loadJson(USERS_PATH);
  const checkins = loadJson(CHECKINS_PATH);

  const totalProfiles = Object.keys(profiles).length;
  const allUserIds = new Set([
    ...Object.keys(profiles),
    ...Object.keys(checkins),
  ]);
  const totalUsers = allUserIds.size;

  let totalCheckins = 0;
  for (const uid of Object.keys(checkins)) {
    totalCheckins += Object.keys(checkins[uid]).length;
  }

  return { totalUsers, totalProfiles, totalCheckins };
}

function register(bot) {
  bot.command('admin', async (ctx) => {
    if (ctx.session?.__scenes) ctx.session.__scenes = {};

    if (!isOwner(ctx)) {
      return ctx.reply('Нямаш достъп до тази команда.');
    }

    const { totalUsers, totalProfiles, totalCheckins } = getAdminStats();

    const msg =
      `🛡 *Админ панел — Здраве на Автопилот*\n\n` +
      `👥 Общо потребители: ${totalUsers}\n` +
      `📋 Профили: ${totalProfiles}\n` +
      `✅ Check-ини: ${totalCheckins}\n` +
      `🤖 Статус на бота: работи нормално\n\n` +
      `*Админ команди:*\n` +
      `/users — Списък с потребители\n` +
      `/usermemory <id> — Виж паметта на потребител\n\n` +
      `*Достъпни команди:*\n` +
      `/profile /myprofile /editprofile /deleteprofile\n` +
      `/plan /checkin /today /history /stats\n` +
      `/showmemory /memory /forget\n` +
      `/ask /whoami /owner /admin`;

    await ctx.replyWithMarkdown(msg);
  });
}

module.exports = { register };
