const { Scenes, Markup } = require('telegraf');
const { isOwner } = require('../adminGuard');
const { addReminder } = require('../reminderStorage');
const { parseTime, parseCustomDays, reminderLine } = require('../reminderUtils');
const {
  DAYS_KEYBOARD,
  CATEGORY_KEYBOARD,
  CUSTOM_DAYS_PROMPT,
  matchDaysPreset,
  matchCategory,
} = require('../reminderInput');

const CANCEL = '❌ Отказ';

function isCancel(text) {
  return text === CANCEL;
}

const addReminderWizard = new Scenes.WizardScene(
  'add-reminder-wizard',

  // Step 0: Guard owner → ask title
  async (ctx) => {
    if (isOwner(ctx)) {
      await ctx.reply(
        'Режимът на собственик е отделен — напомнянията са функция за потребителите. 👑',
        Markup.removeKeyboard()
      );
      return ctx.scene.leave();
    }
    await ctx.reply(
      'Хайде да създадем ново напомняне! ⏰\n\nКак да се казва? (напр. „Пий вода“)',
      Markup.removeKeyboard()
    );
    return ctx.wizard.next();
  },

  // Step 1: Save title → ask time
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (!text) {
      await ctx.reply('Моля, напиши заглавие на напомнянето.');
      return;
    }
    ctx.wizard.state.title = text;
    await ctx.reply(
      'В колко часа да ти напомням? (формат ЧЧ:ММ, напр. 09:00)',
      Markup.removeKeyboard()
    );
    return ctx.wizard.next();
  },

  // Step 2: Save time → ask days
  async (ctx) => {
    const time = parseTime(ctx.message?.text);
    if (!time) {
      await ctx.reply('Моля, въведи валиден час във формат ЧЧ:ММ (напр. 08:30).');
      return;
    }
    ctx.wizard.state.time = time;
    await ctx.reply('В кои дни?', DAYS_KEYBOARD);
    return ctx.wizard.next();
  },

  // Step 3: Handle days choice
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (isCancel(text)) {
      await ctx.reply('Създаването е отменено.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    const match = matchDaysPreset(text);
    if (match === null) {
      await ctx.reply('Моля, избери от предложените опции.', DAYS_KEYBOARD);
      return;
    }
    if (match === 'custom') {
      await ctx.reply(CUSTOM_DAYS_PROMPT, Markup.removeKeyboard());
      return ctx.wizard.selectStep(4);
    }
    ctx.wizard.state.days = match;
    await ctx.reply('Каква категория?', CATEGORY_KEYBOARD);
    return ctx.wizard.selectStep(5);
  },

  // Step 4: Parse custom days → ask category
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (isCancel(text)) {
      await ctx.reply('Създаването е отменено.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    const days = parseCustomDays(text);
    if (!days) {
      await ctx.reply('Не разпознах дни. ' + CUSTOM_DAYS_PROMPT);
      return;
    }
    ctx.wizard.state.days = days;
    await ctx.reply('Каква категория?', CATEGORY_KEYBOARD);
    return ctx.wizard.selectStep(5);
  },

  // Step 5: Save category → persist reminder
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (isCancel(text)) {
      await ctx.reply('Създаването е отменено.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    const category = matchCategory(text);
    if (!category) {
      await ctx.reply('Моля, избери категория от бутоните.', CATEGORY_KEYBOARD);
      return;
    }

    const reminder = addReminder(ctx.from.id, {
      title: ctx.wizard.state.title,
      time: ctx.wizard.state.time,
      days: ctx.wizard.state.days,
      category,
    });

    await ctx.reply(
      `✅ Готово! Създадох напомняне:\n\n${reminderLine(reminder)}\n\n` +
      'Ще ти напомням точно навреме. 💚\nВиж всички с /reminders.',
      Markup.removeKeyboard()
    );
    return ctx.scene.leave();
  }
);

module.exports = addReminderWizard;
