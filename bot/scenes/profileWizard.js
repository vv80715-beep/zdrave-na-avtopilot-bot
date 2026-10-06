const { Scenes, Markup } = require('telegraf');
const { GOALS, ACTIVITY, EXPERIENCE, GENDERS } = require('../constants');
const { saveUser } = require('../storage');
const { addWeightEntry } = require('../memoryStorage');
const { isOwner } = require('../adminGuard');

const profileWizard = new Scenes.WizardScene(
  'profile-wizard',

  // Step 0: Welcome + ask first name
  async (ctx) => {
    await ctx.reply(
      'Здравей! Аз съм Ели и ще ти помогна да създадеш твоя личен профил. 😊\n\nЗапочваме спокойно — как се казваш?',
      Markup.removeKeyboard()
    );
    return ctx.wizard.next();
  },

  // Step 1: Save name → ask age
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (!text) {
      await ctx.reply('Моля, напиши своето ime.');
      return;
    }
    ctx.wizard.state.firstName = text;
    await ctx.reply(`Хубаво е да те запозная, ${text}! 🌟\n\nКолко години си?`);
    return ctx.wizard.next();
  },

  // Step 2: Save age → ask gender
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    const age = parseInt(text, 10);
    if (!text || isNaN(age) || age < 10 || age > 120) {
      await ctx.reply('Моля, въведи валидна възраст — число между 10 и 120.');
      return;
    }
    ctx.wizard.state.age = age;
    await ctx.reply(
      'Какъв е твоят пол? (незадължително)',
      Markup.keyboard([[...GENDERS]]).oneTime().resize()
    );
    return ctx.wizard.next();
  },

  // Step 3: Save gender → ask height
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    ctx.wizard.state.gender = GENDERS.includes(text) ? text : null;
    await ctx.reply(
      'Каква е твоята височина в сантиметри?\n(например: 175)',
      Markup.removeKeyboard()
    );
    return ctx.wizard.next();
  },

  // Step 4: Save height → ask weight
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    const height = parseFloat(text);
    if (!text || isNaN(height) || height < 100 || height > 250) {
      await ctx.reply('Моля, въведи валидна височина в см (например: 175).');
      return;
    }
    ctx.wizard.state.height = height;
    await ctx.reply('Какво е твоето тегло в килограми?\n(например: 70)');
    return ctx.wizard.next();
  },

  // Step 5: Save weight → ask goal
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    const weight = parseFloat(text);
    if (!text || isNaN(weight) || weight < 20 || weight > 500) {
      await ctx.reply('Моля, въведи валидно тегло в кг (например: 70).');
      return;
    }
    ctx.wizard.state.weight = weight;
    await ctx.reply(
      'Каква е твоята основна цел?',
      Markup.keyboard(GOALS.map((g) => [g])).oneTime().resize()
    );
    return ctx.wizard.next();
  },

  // Step 6: Save goal → ask activity level
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (!GOALS.includes(text)) {
      await ctx.reply('Моля, избери една от предложените цели.');
      return;
    }
    ctx.wizard.state.goal = text;
    await ctx.reply(
      'Какво е твоето ниво на активност?\n\n🟢 Ниска — предимно седяща работа, малко движение\n🟡 Средна — активен 2–3 пъти седмично\n🔴 Висока — тренировки 4+ пъти или физическа работа',
      Markup.keyboard([[...ACTIVITY]]).oneTime().resize()
    );
    return ctx.wizard.next();
  },

  // Step 7: Save activity → ask training experience
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (!ACTIVITY.includes(text)) {
      await ctx.reply('Моля, избери едно от предложените нива на активност.');
      return;
    }
    ctx.wizard.state.activityLevel = text;
    await ctx.reply(
      'Какъв е твоят опит с тренировки?\n\n🌱 Начинаещ — малко или никакъв опит\n💪 Средно ниво — тренирал поне 6 месеца\n🏆 Напреднал — редовни тренировки с добра техника',
      Markup.keyboard([[...EXPERIENCE]]).oneTime().resize()
    );
    return ctx.wizard.next();
  },

  // Step 8: Save experience → ask food preferences
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (!EXPERIENCE.includes(text)) {
      await ctx.reply('Моля, избери едно от предложените нива.');
      return;
    }
    ctx.wizard.state.trainingExperience = text;
    await ctx.reply(
      'Имаш ли хранителни предпочитания или алергии? (незадължително)\n\nНапример: вегетарианец, непоносимост към лактоза, без глутен...\n\nАко нямаш, напиши "Нямам".',
      Markup.removeKeyboard()
    );
    return ctx.wizard.next();
  },

  // Step 9: Save food preferences → ask medical notes
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    ctx.wizard.state.foodPreferences =
      !text || text.toLowerCase() === 'нямам' ? null : text;
    await ctx.reply(
      'Имаш ли здравословни състояния или медицински бележки, които да имам предвид? (незадължително)\n\nНапример: високо кръвно, диабет, травма на коляното...\n\nАко няма, натисни "Нямам".',
      Markup.keyboard([['Нямам']]).oneTime().resize()
    );
    return ctx.wizard.next();
  },

  // Step 10: Save medical notes → finalise profile
  async (ctx) => {
    const text = ctx.message?.text?.trim();
    ctx.wizard.state.medicalNotes =
      !text || text.toLowerCase() === 'нямам' ? null : text;

    const now = new Date().toISOString();
    const profile = {
      firstName: ctx.wizard.state.firstName,
      age: ctx.wizard.state.age,
      gender: ctx.wizard.state.gender,
      height: ctx.wizard.state.height,
      weight: ctx.wizard.state.weight,
      goal: ctx.wizard.state.goal,
      activityLevel: ctx.wizard.state.activityLevel,
      trainingExperience: ctx.wizard.state.trainingExperience,
      foodPreferences: ctx.wizard.state.foodPreferences,
      medicalNotes: ctx.wizard.state.medicalNotes,
      createdAt: now,
      updatedAt: now,
    };

    saveUser(ctx.from.id, profile);

    if (typeof profile.weight === 'number' && !isOwner(ctx)) {
      addWeightEntry(ctx.from.id, profile.weight);
    }

    await ctx.reply(
      `Перфектно, ${profile.firstName}! 🎉\n\nПрофилът ти е запазен. Вече мога да ти помогна с персонализирани съвети.\n\n👉 Опитай /plan за твоя личен 7-дневен план\n👉 Или използвай /ask за директен въпрос към Ели`,
      Markup.removeKeyboard()
    );

    return ctx.scene.leave();
  }
);

module.exports = profileWizard;
