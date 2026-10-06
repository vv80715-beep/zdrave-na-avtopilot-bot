const { Markup } = require('telegraf');
const { getUser, deleteUser } = require('../storage');
const { deleteUserLog } = require('../dailyLogStorage');

function register(bot) {
  bot.command('deleteprofile', async (ctx) => {
    const profile = getUser(ctx.from.id);
    if (!profile) {
      return ctx.reply(
        'Нямаш запазен профил, така че няма какво да изтрия. 😊'
      );
    }

    await ctx.reply(
      `Сигурен/а ли си, че искаш да изтриеш профила си, ${profile.firstName}? Това действие не може да бъде отменено.`,
      Markup.inlineKeyboard([
        Markup.button.callback('✅ Да, изтрий', 'delete_confirm_yes'),
        Markup.button.callback('❌ Не, запази', 'delete_confirm_no'),
      ])
    );
  });

  bot.action('delete_confirm_yes', async (ctx) => {
    await ctx.answerCbQuery();
    const profile = getUser(ctx.from.id);
    const name = profile?.firstName || 'приятел';
    deleteUser(ctx.from.id);
    deleteUserLog(ctx.from.id);
    await ctx.editMessageText(
      `Профилът ти беше изтрит, ${name}. Можеш да създадеш нов по всяко време с /profile. 💙`
    );
  });

  bot.action('delete_confirm_no', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Добре! Профилът ти е запазен. 😊');
  });
}

module.exports = { register };
