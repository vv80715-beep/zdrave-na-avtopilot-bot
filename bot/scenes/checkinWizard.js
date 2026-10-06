const { Scenes, Markup } = require('telegraf');
const { saveCheckin, getTodayCheckin } = require('../checkinStorage');
const { setMotivation, setLastWorkout } = require('../memoryStorage');
const { isOwner } = require('../adminGuard');

const YES_NO = Markup.keyboard([['✅ Да', '❌ Не']]).oneTime().resize();
const SCALE_10 = Markup.keyboard([
  ['1', '2', '3', '4', '5'],
  ['6', '7', '8', '9', '10'],
]).oneTime().resize();

function isYes(text) {
  return text === '✅ Да';
}

function isValidYesNo(text) {
  return text === '✅ Да' || text === '❌ Не';
}

function parseScale(text) {
  const n = parseInt(text, 10);
  return !isNaN(n) && n >= 1 && n <= 10 ? n : null;
}

const COMPLETION_MESSAGE =
  'Страхотна работа! 🎉\n\n' +
  'Всеки малък навик те доближава до целта ти.\n\n' +
  'Продължавай така и не се стреми към съвършенство — постоянството печели.\n\n' +
  'Утре ще проверим отново как върви напредъкът. 💚';

const checkinWizard = new Scenes.WizardScene(
  'checkin-wizard',

  // Step 0: Guard + ask about water
  async (ctx) => {
    const existing = getTodayCheckin(ctx.from.id);
    if (existing) {
      await ctx.reply(
        'Вече си направил/а своя дневен check-in за днес! 🌟\n\nИзползвай /today за да видиш отговорите си.',
        Markup.removeKeyboard()
      );
      return ctx.scene.leave();
    }
    await ctx.reply(
      'Хайде да направим дневния check-in! 💪\n\nПий ли достатъчно вода днес?',
      YES_NO
    );
    return ctx.wizard.next();
  },

  // Step 1: Save water → ask about training
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (!isValidYesNo(text)) {
      await ctx.reply('Моля, избери "✅ Да" или "❌ Не".', YES_NO);
      return;
    }
    ctx.wizard.state.water = isYes(text);
    await ctx.reply('Тренира ли днес?', YES_NO);
    return ctx.wizard.next();
  },

  // Step 2: Save training → ask about nutrition
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (!isValidYesNo(text)) {
      await ctx.reply('Моля, избери "✅ Да" или "❌ Не".', YES_NO);
      return;
    }
    ctx.wizard.state.trained = isYes(text);
    await ctx.reply('Яде ли според целта си днес?', YES_NO);
    return ctx.wizard.next();
  },

  // Step 3: Save nutrition → ask about sleep
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (!isValidYesNo(text)) {
      await ctx.reply('Моля, избери "✅ Да" или "❌ Не".', YES_NO);
      return;
    }
    ctx.wizard.state.nutrition = isYes(text);
    await ctx.reply(
      'Колко часа си спал/а тази нощ?\n(напиши число, например: 7 или 7.5)',
      Markup.removeKeyboard()
    );
    return ctx.wizard.next();
  },

  // Step 4: Save sleep → ask about mood
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    const sleep = parseFloat(text);
    if (isNaN(sleep) || sleep < 0 || sleep > 24) {
      await ctx.reply('Моля, въведи валиден брой часове сън (например: 7 или 7.5).');
      return;
    }
    ctx.wizard.state.sleep = sleep;
    await ctx.reply('Как е настроението ти днес? (1 = много лошо, 10 = страхотно)', SCALE_10);
    return ctx.wizard.next();
  },

  // Step 5: Save mood → ask about energy
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    const mood = parseScale(text);
    if (mood === null) {
      await ctx.reply('Моля, избери число от 1 до 10.', SCALE_10);
      return;
    }
    ctx.wizard.state.mood = mood;
    await ctx.reply('Колко енергия имаш днес? (1 = изтощен/а, 10 = пълен/а с енергия)', SCALE_10);
    return ctx.wizard.next();
  },

  // Step 6: Save energy → persist + motivate
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    const energy = parseScale(text);
    if (energy === null) {
      await ctx.reply('Моля, избери число от 1 до 10.', SCALE_10);
      return;
    }
    ctx.wizard.state.energy = energy;

    saveCheckin(ctx.from.id, {
      water: ctx.wizard.state.water,
      trained: ctx.wizard.state.trained,
      nutrition: ctx.wizard.state.nutrition,
      sleep: ctx.wizard.state.sleep,
      mood: ctx.wizard.state.mood,
      energy,
    });

    // Update long-term memory from this check-in (never for the owner).
    if (!isOwner(ctx)) {
      const motivation = Math.round((ctx.wizard.state.mood + energy) / 2);
      setMotivation(ctx.from.id, motivation);
      if (ctx.wizard.state.trained) {
        setLastWorkout(ctx.from.id, {
          date: new Date().toISOString(),
          note: 'Тренировка, отчетена при дневния check-in',
        });
      }
    }

    await ctx.reply(COMPLETION_MESSAGE, Markup.removeKeyboard());
    return ctx.scene.leave();
  }
);

module.exports = checkinWizard;
