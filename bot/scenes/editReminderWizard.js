const { Scenes, Markup } = require('telegraf');
const { isOwner } = require('../adminGuard');
const { getReminders, getReminder, updateReminder } = require('../reminderStorage');
const { parseTime, parseCustomDays, reminderLine } = require('../reminderUtils');
const {
  DAYS_KEYBOARD,
  CATEGORY_KEYBOARD,
  CUSTOM_DAYS_PROMPT,
  matchDaysPreset,
  matchCategory,
} = require('../reminderInput');

const CANCEL = '❌ Отказ';

const FIELD_LABELS = {
  title: 'Заглавие',
  time: 'Час',
  days: 'Дни',
  category: 'Категория',
};

function isCancel(text) {
  return text === CANCEL;
}

async function applyAndFinish(ctx, patch) {
  const updated = updateReminder(ctx.from.id, ctx.wizard.state.reminderId, patch);
  if (!updated) {
    await ctx.reply('Напомнянето вече не съществува.', Markup.removeKeyboard());
    return ctx.scene.leave();
  }
  await ctx.reply(
    `✅ Обновено:\n\n${reminderLine(updated)}`,
    Markup.removeKeyboard()
  );
  return ctx.scene.leave();
}

const editReminderWizard = new Scenes.WizardScene(
  'edit-reminder-wizard',

  // Step 0: Guard owner → list reminders to pick
  async (ctx) => {
    if (isOwner(ctx)) {
      await ctx.reply(
        'Режимът на собственик е отделен — напомнянията са функция за потребителите. 👑',
        Markup.removeKeyboard()
      );
      return ctx.scene.leave();
    }
    const list = getReminders(ctx.from.id);
    if (list.length === 0) {
      await ctx.reply(
        'Нямаш създадени напомняния. Добави едно с /addreminder. 😊',
        Markup.removeKeyboard()
      );
      return ctx.scene.leave();
    }
    ctx.wizard.state.options = list.map((r) => ({ id: r.id, label: reminderLine(r) }));
    const keyboard = ctx.wizard.state.options
      .map((o) => [o.label])
      .concat([[CANCEL]]);
    await ctx.reply(
      'Кое напомняне искаш да редактираш?',
      Markup.keyboard(keyboard).oneTime().resize()
    );
    return ctx.wizard.next();
  },

  // Step 1: Pick reminder → choose field
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (isCancel(text)) {
      await ctx.reply('Редактирането е отменено.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    const choice = (ctx.wizard.state.options || []).find((o) => o.label === text);
    if (!choice) {
      await ctx.reply('Моля, избери напомняне от бутоните.');
      return;
    }
    ctx.wizard.state.reminderId = choice.id;
    await ctx.reply(
      'Какво искаш да промениш?',
      Markup.keyboard([
        [FIELD_LABELS.title],
        [FIELD_LABELS.time],
        [FIELD_LABELS.days],
        [FIELD_LABELS.category],
        [CANCEL],
      ])
        .oneTime()
        .resize()
    );
    return ctx.wizard.next();
  },

  // Step 2: Pick field → prompt for new value
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (isCancel(text)) {
      await ctx.reply('Редактирането е отменено.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    const field = Object.keys(FIELD_LABELS).find((k) => FIELD_LABELS[k] === text);
    if (!field) {
      await ctx.reply('Моля, избери поле от бутоните.');
      return;
    }
    // Make sure the reminder still exists.
    if (!getReminder(ctx.from.id, ctx.wizard.state.reminderId)) {
      await ctx.reply('Напомнянето вече не съществува.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }

    ctx.wizard.state.field = field;

    if (field === 'title') {
      await ctx.reply('Ново заглавие:', Markup.removeKeyboard());
      return ctx.wizard.selectStep(3);
    }
    if (field === 'time') {
      await ctx.reply('Нов час (ЧЧ:ММ, напр. 09:00):', Markup.removeKeyboard());
      return ctx.wizard.selectStep(3);
    }
    if (field === 'category') {
      await ctx.reply('Нова категория:', CATEGORY_KEYBOARD);
      return ctx.wizard.selectStep(3);
    }
    // days
    await ctx.reply('Нови дни:', DAYS_KEYBOARD);
    return ctx.wizard.selectStep(4);
  },

  // Step 3: Apply title / time / category
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (isCancel(text)) {
      await ctx.reply('Редактирането е отменено.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    const field = ctx.wizard.state.field;

    if (field === 'title') {
      if (!text) {
        await ctx.reply('Заглавието не може да е празно. Опитай отново.');
        return;
      }
      return applyAndFinish(ctx, { title: text });
    }
    if (field === 'time') {
      const time = parseTime(text);
      if (!time) {
        await ctx.reply('Невалиден час. Въведи във формат ЧЧ:ММ (напр. 08:30).');
        return;
      }
      return applyAndFinish(ctx, { time });
    }
    // category
    const category = matchCategory(text);
    if (!category) {
      await ctx.reply('Моля, избери категория от бутоните.', CATEGORY_KEYBOARD);
      return;
    }
    return applyAndFinish(ctx, { category });
  },

  // Step 4: Days choice
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (isCancel(text)) {
      await ctx.reply('Редактирането е отменено.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    const match = matchDaysPreset(text);
    if (match === null) {
      await ctx.reply('Моля, избери от предложените опции.', DAYS_KEYBOARD);
      return;
    }
    if (match === 'custom') {
      await ctx.reply(CUSTOM_DAYS_PROMPT, Markup.removeKeyboard());
      return ctx.wizard.selectStep(5);
    }
    return applyAndFinish(ctx, { days: match });
  },

  // Step 5: Parse custom days
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (isCancel(text)) {
      await ctx.reply('Редактирането е отменено.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    const days = parseCustomDays(text);
    if (!days) {
      await ctx.reply('Не разпознах дни. ' + CUSTOM_DAYS_PROMPT);
      return;
    }
    return applyAndFinish(ctx, { days });
  }
);

module.exports = editReminderWizard;
