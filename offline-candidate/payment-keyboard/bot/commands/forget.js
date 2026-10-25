const { Markup } = require('telegraf');
const { isOwner } = require('../adminGuard');
const { deleteMemory } = require('../memoryStorage');
const { deleteUserLog } = require('../dailyLogStorage');

function register(bot) {
  bot.command('forget', (ctx) => {
    if (ctx.session?.__scenes) ctx.session.__scenes = {};

    // The owner identity cannot be forgotten.
    if (isOwner(ctx)) {
      return ctx.reply(
        'Твоята идентичност като собственик е постоянна и не може да бъде изтрита. 👑'
      );
    }

    return ctx.reply(
      '⚠️ Сигурен/на ли си? Това ще изтрие всичко, което помня за теб — ' +
      'предпочитания, навици, мотивация и история на разговорите.',
      Markup.inlineKeyboard([
        Markup.button.callback('🗑 Да, забрави всичко', 'forget_yes'),
        Markup.button.callback('❌ Отказ', 'forget_no'),
      ])
    );
  });

  bot.action('forget_yes', async (ctx) => {
    if (isOwner(ctx)) {
      await ctx.answerCbQuery();
      return ctx.editMessageText('Идентичността на собственика не може да се изтрие. 👑');
    }
    const existed = deleteMemory(ctx.from.id);
    deleteUserLog(ctx.from.id);
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      existed
        ? '🧹 Готово. Забравих всичко за теб. Започваме на чисто! 😊'
        : 'Нямаше какво да забравям — паметта вече беше празна. 😊'
    );
  });

  bot.action('forget_no', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Добре, запазвам всичко както си е. 💙');
  });
}

module.exports = { register };
