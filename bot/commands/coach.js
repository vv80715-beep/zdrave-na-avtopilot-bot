const openai = require('../openaiClient');
const { isOwner } = require('../adminGuard');
const { gateChat } = require('../chatGate');
const {
  generateCoach,
  generateMotivate,
  generateNextStep,
  generateWeeklyReview,
} = require('../coachService');

async function sendLong(ctx, text) {
  const MAX = 4000;
  if (text.length <= MAX) return ctx.reply(text);
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      await ctx.reply(remaining);
      break;
    }
    let cut = remaining.lastIndexOf('\n', MAX);
    if (cut === -1) cut = MAX;
    await ctx.reply(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
}

function clearScene(ctx) {
  if (ctx.session?.__scenes) ctx.session.__scenes = {};
}

async function run(ctx, generator, emptyMsg) {
  clearScene(ctx);
  if (!openai) {
    return ctx.reply('OpenAI не е конфигуриран. Моля, провери настройките на бота.');
  }
  // Entitlement gate: an expired trial gets the static message — no AI call.
  const status = await gateChat(ctx);
  if (!status) return;
  try {
    await ctx.sendChatAction('typing');
    const text = await generator(ctx.from.id);
    if (!text) {
      return ctx.reply(emptyMsg || 'Не получих отговор. Опитай отново. 😊');
    }
    // One-time premium-expiry notice rides along in the same single delivery.
    await sendLong(ctx, status.notice ? `${status.notice}\n\n${text}` : text);
  } catch (err) {
    console.error('Coaching error:', err.message);
    await ctx.reply('Нещо се обърка. Опитай отново малко по-късно.');
  }
}

function register(bot) {
  bot.command('coach', (ctx) =>
    run(ctx, (uid) => generateCoach(openai, uid, { persist: !isOwner(ctx) }))
  );

  bot.command('motivate', (ctx) =>
    run(ctx, (uid) => generateMotivate(openai, uid, { persist: !isOwner(ctx) }))
  );

  bot.command('nextstep', (ctx) =>
    run(ctx, (uid) => generateNextStep(openai, uid))
  );

  bot.command('weeklyreview', (ctx) =>
    run(
      ctx,
      (uid) => generateWeeklyReview(openai, uid),
      'Все още нямаш достатъчно данни за седмичен преглед. Направи /checkin няколко дни и пробвай пак! 😊'
    )
  );
}

module.exports = { register };
