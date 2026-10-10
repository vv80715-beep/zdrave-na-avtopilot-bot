const { getUser } = require('../storage');
const { SYSTEM_PROMPT, stripLeadingGreeting } = require('../prompts');
const openai = require('../openaiClient');
const { addPlan } = require('../memoryStorage');
const { isOwner } = require('../adminGuard');
const { gateChat } = require('../chatGate');
const { getUniversalMemoryRuntime } = require('../brain/universal/runtime');

function buildPlanPrompt(profile) {
  return (
    `Потребителят иска персонализиран 7-дневен стартов план.\n\n` +
    `Профил:\n` +
    `- Име: ${profile.firstName}\n` +
    `- Възраст: ${profile.age} год.\n` +
    `- Пол: ${profile.gender || 'не е посочен'}\n` +
    `- Височина: ${profile.height} см\n` +
    `- Тегло: ${profile.weight} кг\n` +
    `- Основна цел: ${profile.goal}\n` +
    `- Ниво на активност: ${profile.activityLevel}\n` +
    `- Опит с тренировки: ${profile.trainingExperience}\n` +
    `- Хранителни предпочитания/алергии: ${profile.foodPreferences || 'няма'}\n\n` +
    `Създай структуриран 7-дневен план. За всеки ден включи:\n` +
    `• Дневен навик\n` +
    `• Прием на вода\n` +
    `• Цел за сън\n` +
    `• Тренировъчно предложение (подходящо за нивото на опит)\n` +
    `• Хранителен съвет\n` +
    `• Мотивация за деня\n\n` +
    `Говори директно към ${profile.firstName} с топлия тон на Ели. ` +
    `Дръж всеки ден кратък и ясен. ` +
    `Завърши с едно общо насърчаващо послание.`
  );
}

async function sendLongMessage(ctx, text) {
  const MAX = 4000;
  if (text.length <= MAX) {
    return ctx.reply(text);
  }
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      parts.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf('\n', MAX);
    if (cut === -1) cut = MAX;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  for (const part of parts) {
    await ctx.reply(part);
  }
}

function register(bot) {
  bot.command('plan', async (ctx) => {
    const profile = getUser(ctx.from.id);
    if (!profile) {
      return ctx.reply(
        'Нямаш запазен профил. Използвай /profile първо, за да мога да ти направя персонализиран план. 😊'
      );
    }

    if (!openai) {
      return ctx.reply(
        'OpenAI не е конфигуриран. Моля, провери настройките на бота.'
      );
    }

    // Entitlement gate: an expired trial gets the static message — no AI call.
    const status = await gateChat(ctx);
    if (!status) return;
    const universal = getUniversalMemoryRuntime();
    const canonical = universal.active(ctx.from.id);
    if (canonical && ctx.chat?.type !== 'private') return ctx.reply('Поискай личния план в личния чат с Ели.');

    await ctx.sendChatAction('typing');
    await ctx.reply(
      canonical ? 'Подготвям твоя личен 7-дневен план! Изчакай малко... 🌟' : `Подготвям твоя личен 7-дневен план, ${profile.firstName}! Изчакай малко... 🌟`
    );

    try {
      const canonicalContext = canonical ? await universal.context(ctx, '7-дневен план според личните цели, навици, хранителни и тренировъчни предпочитания') : '';
      const healthMeasurements = Object.fromEntries(['age', 'height', 'weight'].map((key) => [key, Number.isFinite(profile[key]) ? profile[key] : null]));
      const planRequest = canonical
        ? 'Създай кратък персонализиран 7-дневен стартов план с навици, вода, сън, тренировки, хранене и мотивация. Здравни измервания (JSON данни): ' + JSON.stringify(healthMeasurements) + '. Ако липсва необходим личен факт, попитай, без да го измисляш.'
        : buildPlanPrompt(profile);
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT + canonicalContext },
          { role: 'user', content: planRequest },
        ],
        max_tokens: 2000,
      });

      const raw = completion.choices[0]?.message?.content;
      if (!raw) {
        return ctx.reply('Не получих отговор от AI. Опитай отново.');
      }

      // The plan is content-first; drop any greeting the model may prepend.
      // One-time premium-expiry notice rides along in the same delivery.
      const plan = stripLeadingGreeting(raw);
      await sendLongMessage(ctx, status.notice ? `${status.notice}\n\n${plan}` : plan);

      // Remember that a plan was created (never for the owner).
      if (!isOwner(ctx)) {
        addPlan(ctx.from.id, canonical ? 'Създаден 7-дневен план' : `7-дневен план за цел: ${profile.goal}`);
      }
    } catch (err) {
      console.error('Plan generation error:', err.message);
      await ctx.reply(
        'Нещо се обърка при генерирането на плана. Опитай отново малко по-късно.'
      );
    }
  });
}

module.exports = { register };

