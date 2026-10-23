const { Scenes, Markup } = require('telegraf');
const { FIELD_LABELS, FIELD_CHOICES } = require('../constants');
const { getUser, saveUser } = require('../storage');
const { addWeightEntry } = require('../memoryStorage');
const { isOwner } = require('../adminGuard');
const { validateProfileField } = require('../profileInput');

const EDITABLE_FIELDS = Object.keys(FIELD_LABELS);

const editWizard = new Scenes.WizardScene(
  'edit-wizard',

  // Step 0: Show field selection
  async (ctx) => {
    const profile = getUser(ctx.from.id);
    if (!profile) {
      await ctx.reply(
        'Нямаш запазен профил. Използвай /profile за да създадеш един.',
        Markup.removeKeyboard()
      );
      return ctx.scene.leave();
    }

    const keyboard = EDITABLE_FIELDS.map((f) => [FIELD_LABELS[f]]).concat([
      ['❌ Отказ'],
    ]);
    await ctx.reply(
      'Кое поле искаш да промениш?',
      Markup.keyboard(keyboard).oneTime().resize()
    );
    return ctx.wizard.next();
  },

  // Step 1: Save field choice → show appropriate prompt
  async (ctx) => {
    const text = ctx.message?.text?.trim();

    if (text === '❌ Отказ') {
      await ctx.reply('Редактирането е отменено.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }

    const fieldKey = EDITABLE_FIELDS.find((k) => FIELD_LABELS[k] === text);
    if (!fieldKey) {
      await ctx.reply('Моля, избери едно от предложените полета.');
      return;
    }

    ctx.wizard.state.editingField = fieldKey;

    if (FIELD_CHOICES[fieldKey]) {
      const choices = FIELD_CHOICES[fieldKey];
      const rows =
        fieldKey === 'gender'
          ? [...choices.map((c) => [c]), ['Пропусни']]
          : choices.map((c) => [c]);
      await ctx.reply(
        `Нова стойност за "${FIELD_LABELS[fieldKey]}":`,
        Markup.keyboard(rows).oneTime().resize()
      );
    } else if (fieldKey === 'foodPreferences' || fieldKey === 'medicalNotes') {
      await ctx.reply(
        `Нова стойност за "${FIELD_LABELS[fieldKey]}":\n(Напиши "Нямам" за да изчистиш полето)`,
        Markup.removeKeyboard()
      );
    } else {
      await ctx.reply(
        `Нова стойност за "${FIELD_LABELS[fieldKey]}":`,
        Markup.removeKeyboard()
      );
    }

    return ctx.wizard.next();
  },

  // Step 2: Validate new value → save
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    const field = ctx.wizard.state.editingField;
    const profile = getUser(ctx.from.id);

    if (!profile) {
      await ctx.reply('Профилът не беше намерен.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }

    let newValue;
    try {
      newValue = validateProfileField(field, text);
    } catch {
      const errors = {
        age: 'Моля, въведи валидна възраст (число между 10 и 120).',
        height: 'Моля, въведи валидна височина (100–250 см).',
        weight: 'Моля, въведи валидно тегло (20–500 кг).',
      };
      await ctx.reply(errors[field] || (FIELD_CHOICES[field]
        ? 'Моля, избери валидна опция от менюто.'
        : 'Стойността не може да е празна. Моля, опитай отново.'));
      return;
    }

    profile[field] = newValue;
    profile.updatedAt = new Date().toISOString();
    saveUser(ctx.from.id, profile);

    if (field === 'weight' && !isOwner(ctx)) {
      addWeightEntry(ctx.from.id, newValue);
    }

    await ctx.reply(
      `✅ "${FIELD_LABELS[field]}" е обновено успешно!`,
      Markup.removeKeyboard()
    );
    return ctx.scene.leave();
  }
);

module.exports = editWizard;
