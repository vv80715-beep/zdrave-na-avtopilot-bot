const { Scenes, Markup } = require('telegraf');
const { MEMORY_FIELD_LABELS } = require('../constants');
const { setField } = require('../memoryStorage');

const EDITABLE_FIELDS = Object.keys(MEMORY_FIELD_LABELS);

const memoryWizard = new Scenes.WizardScene(
  'memory-wizard',

  // Step 0: Show field selection
  async (ctx) => {
    const keyboard = EDITABLE_FIELDS.map((f) => [MEMORY_FIELD_LABELS[f]]).concat([
      ['❌ Отказ'],
    ]);
    await ctx.reply(
      'Какво да запомня или обновя за теб? Избери поле:',
      Markup.keyboard(keyboard).oneTime().resize()
    );
    return ctx.wizard.next();
  },

  // Step 1: Save field choice → prompt for value
  async (ctx) => {
    const text = ctx.message?.text?.trim();

    if (text === '❌ Отказ') {
      await ctx.reply('Добре, нищо не променям. 😊', Markup.removeKeyboard());
      return ctx.scene.leave();
    }

    const fieldKey = EDITABLE_FIELDS.find((k) => MEMORY_FIELD_LABELS[k] === text);
    if (!fieldKey) {
      await ctx.reply('Моля, избери едно от предложените полета.');
      return;
    }

    ctx.wizard.state.editingField = fieldKey;

    if (fieldKey === 'motivationLevel') {
      await ctx.reply(
        'Колко мотивиран/а се чувстваш в момента? (1 = никак, 10 = максимално)',
        Markup.keyboard([
          ['1', '2', '3', '4', '5'],
          ['6', '7', '8', '9', '10'],
        ]).oneTime().resize()
      );
    } else {
      await ctx.reply(
        `Какво да запомня за "${MEMORY_FIELD_LABELS[fieldKey]}"?\n(Напиши "Изчисти" за да премахна това.)`,
        Markup.removeKeyboard()
      );
    }

    return ctx.wizard.next();
  },

  // Step 2: Validate → save
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    const field = ctx.wizard.state.editingField;

    let newValue;

    if (field === 'motivationLevel') {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1 || n > 10) {
        await ctx.reply('Моля, избери число от 1 до 10.');
        return;
      }
      newValue = n;
    } else {
      if (!text) {
        await ctx.reply('Стойността не може да е празна. Опитай отново.');
        return;
      }
      newValue = text.toLowerCase() === 'изчисти' ? null : text;
    }

    setField(ctx.from.id, field, newValue);

    await ctx.reply(
      `✅ Запомних! "${MEMORY_FIELD_LABELS[field]}" е обновено.\n\nВиж всичко с /showmemory.`,
      Markup.removeKeyboard()
    );
    return ctx.scene.leave();
  }
);

module.exports = memoryWizard;
