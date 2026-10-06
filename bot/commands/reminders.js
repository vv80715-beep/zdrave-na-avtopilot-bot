const { Markup } = require('telegraf');
const { isOwner } = require('../adminGuard');
const {
  getReminders,
  getReminder,
  deleteReminder,
  setPaused,
} = require('../reminderStorage');
const { reminderLine } = require('../reminderUtils');

const OWNER_MSG =
  'Режимът на собственик е отделен — напомнянията са функция за потребителите. 👑';

function clearScene(ctx) {
  if (ctx.session?.__scenes) ctx.session.__scenes = {};
}

function listKeyboard(reminders, prefix) {
  return Markup.inlineKeyboard(
    reminders.map((r) => [Markup.button.callback(reminderLine(r), `${prefix}${r.id}`)])
  );
}

function register(bot) {
  // /reminders — show all reminders
  bot.command('reminders', (ctx) => {
    clearScene(ctx);
    if (isOwner(ctx)) return ctx.reply(OWNER_MSG);

    const list = getReminders(ctx.from.id);
    if (list.length === 0) {
      return ctx.reply(
        'Нямаш активни напомняния. 🌱\n\nСъздай първото с /addreminder.'
      );
    }
    const lines = list.map((r) => `• ${reminderLine(r)}`).join('\n');
    return ctx.reply(
      `⏰ Твоите напомняния:\n\n${lines}\n\n` +
      'Управление: /addreminder, /editreminder, /deletereminder, /pause, /resume'
    );
  });

  // /deletereminder — pick one to delete
  bot.command('deletereminder', (ctx) => {
    clearScene(ctx);
    if (isOwner(ctx)) return ctx.reply(OWNER_MSG);

    const list = getReminders(ctx.from.id);
    if (list.length === 0) {
      return ctx.reply('Нямаш напомняния за изтриване. 😊');
    }
    return ctx.reply('Кое напомняне да изтрия?', listKeyboard(list, 'rem_del_'));
  });

  bot.action(/^rem_del_(.+)$/, async (ctx) => {
    if (isOwner(ctx)) {
      await ctx.answerCbQuery();
      return;
    }
    const id = ctx.match[1];
    const reminder = getReminder(ctx.from.id, id);
    await ctx.answerCbQuery();
    if (!reminder) {
      return ctx.editMessageText('Това напомняне вече не съществува.');
    }
    return ctx.editMessageText(
      `⚠️ Да изтрия ли това напомняне?\n\n${reminderLine(reminder)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🗑 Да, изтрий', `rem_delok_${id}`)],
        [Markup.button.callback('❌ Отказ', 'rem_delcancel')],
      ])
    );
  });

  bot.action(/^rem_delok_(.+)$/, async (ctx) => {
    if (isOwner(ctx)) {
      await ctx.answerCbQuery();
      return;
    }
    const id = ctx.match[1];
    const ok = deleteReminder(ctx.from.id, id);
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      ok ? '🗑 Напомнянето е изтрито.' : 'Напомнянето вече не съществуваше.'
    );
  });

  bot.action('rem_delcancel', async (ctx) => {
    await ctx.answerCbQuery();
    if (isOwner(ctx)) return;
    return ctx.editMessageText('Добре, запазвам напомнянето. 💙');
  });

  // /pause — pause an active reminder
  bot.command('pause', (ctx) => {
    clearScene(ctx);
    if (isOwner(ctx)) return ctx.reply(OWNER_MSG);

    const active = getReminders(ctx.from.id).filter((r) => !r.paused);
    if (active.length === 0) {
      return ctx.reply('Нямаш активни напомняния за паузиране. 😊');
    }
    return ctx.reply('Кое напомняне да паузирам?', listKeyboard(active, 'rem_pause_'));
  });

  bot.action(/^rem_pause_(.+)$/, async (ctx) => {
    if (isOwner(ctx)) {
      await ctx.answerCbQuery();
      return;
    }
    const id = ctx.match[1];
    const updated = setPaused(ctx.from.id, id, true);
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      updated
        ? `⏸️ Паузирах:\n\n${reminderLine(updated)}\n\nПоднови с /resume.`
        : 'Напомнянето вече не съществува.'
    );
  });

  // /resume — re-enable a paused reminder
  bot.command('resume', (ctx) => {
    clearScene(ctx);
    if (isOwner(ctx)) return ctx.reply(OWNER_MSG);

    const paused = getReminders(ctx.from.id).filter((r) => r.paused);
    if (paused.length === 0) {
      return ctx.reply('Нямаш паузирани напомняния. 😊');
    }
    return ctx.reply('Кое напомняне да подновя?', listKeyboard(paused, 'rem_resume_'));
  });

  bot.action(/^rem_resume_(.+)$/, async (ctx) => {
    if (isOwner(ctx)) {
      await ctx.answerCbQuery();
      return;
    }
    const id = ctx.match[1];
    const updated = setPaused(ctx.from.id, id, false);
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      updated
        ? `▶️ Подново активно:\n\n${reminderLine(updated)}`
        : 'Напомнянето вече не съществува.'
    );
  });
}

module.exports = { register };
