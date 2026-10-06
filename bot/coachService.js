const { getUser } = require('./storage');
const { getMemory, getWeightLog, addSentMotivation, getSentMotivations } = require('./memoryStorage');
const { getHistory } = require('./checkinStorage');
const { SYSTEM_PROMPT, stripLeadingGreeting } = require('./prompts');

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function pct(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

// Deterministic weekly stats from the last 7 check-ins.
function computeWeekly(userId) {
  const week = getHistory(userId, 7);
  const count = week.length;
  if (count === 0) {
    return { count: 0 };
  }
  const trainedDays = week.filter((e) => e.trained).length;
  const waterDays = week.filter((e) => e.water).length;
  const nutritionDays = week.filter((e) => e.nutrition).length;
  return {
    count,
    trainedDays,
    waterDays,
    nutritionDays,
    trainPct: pct(trainedDays, count),
    waterPct: pct(waterDays, count),
    nutritionPct: pct(nutritionDays, count),
    avgSleep: round1(avg(week.map((e) => e.sleep))),
    avgMood: round1(avg(week.map((e) => e.mood))),
    avgEnergy: round1(avg(week.map((e) => e.energy))),
  };
}

function computeWeightProgress(userId) {
  const profile = getUser(userId);
  const log = getWeightLog(userId);
  if (log.length >= 2) {
    const first = log[0];
    const last = log[log.length - 1];
    const delta = round1(last.weight - first.weight);
    return {
      current: last.weight,
      start: first.weight,
      delta,
      entries: log.length,
    };
  }
  return {
    current: profile?.weight ?? null,
    start: profile?.weight ?? null,
    delta: null,
    entries: log.length,
  };
}

// A compact facts block the AI uses to ground every coaching message.
function buildCoachingFacts(userId) {
  const profile = getUser(userId);
  const memory = getMemory(userId);
  const weekly = computeWeekly(userId);
  const weight = computeWeightProgress(userId);

  const lines = ['ДАННИ ЗА ПОТРЕБИТЕЛЯ:'];

  if (profile) {
    if (profile.firstName) lines.push(`- Име: ${profile.firstName}`);
    if (profile.age != null) lines.push(`- Възраст: ${profile.age}`);
    if (profile.goal) lines.push(`- Цел: ${profile.goal}`);
    if (profile.activityLevel) lines.push(`- Активност: ${profile.activityLevel}`);
    if (profile.trainingExperience) lines.push(`- Опит: ${profile.trainingExperience}`);
  }

  if (memory) {
    if (memory.injuries) lines.push(`- Травми: ${memory.injuries}`);
    if (memory.allergies) lines.push(`- Алергии: ${memory.allergies}`);
    if (memory.favoriteFoods) lines.push(`- Любими храни: ${memory.favoriteFoods}`);
    if (memory.dislikedFoods) lines.push(`- Нелюбими храни: ${memory.dislikedFoods}`);
    if (memory.dailyHabits) lines.push(`- Дневни навици: ${memory.dailyHabits}`);
    if (memory.motivationLevel != null) lines.push(`- Ниво на мотивация: ${memory.motivationLevel}/10`);
    if (memory.lastWorkout?.date) {
      lines.push(`- Последна тренировка: ${new Date(memory.lastWorkout.date).toLocaleDateString('bg-BG')}`);
    }
    if (memory.plans?.length) {
      lines.push(`- Създадени планове: ${memory.plans.length} (последен: ${memory.plans[memory.plans.length - 1].summary})`);
    }
  }

  if (weekly.count > 0) {
    lines.push(
      `- Последни 7 дни (${weekly.count} check-ина): тренировки ${weekly.trainedDays}/${weekly.count} (${weekly.trainPct}%), ` +
      `вода ${weekly.waterDays}/${weekly.count} (${weekly.waterPct}%), хранене ${weekly.nutritionDays}/${weekly.count} (${weekly.nutritionPct}%), ` +
      `среден сън ${weekly.avgSleep}ч, настроение ${weekly.avgMood}/10, енергия ${weekly.avgEnergy}/10`
    );
  } else {
    lines.push('- Все още няма check-ини за анализ.');
  }

  if (weight.current != null) {
    if (weight.delta != null) {
      const dir = weight.delta < 0 ? 'надолу' : weight.delta > 0 ? 'нагоре' : 'без промяна';
      lines.push(`- Тегло: ${weight.current} кг (от ${weight.start} кг, промяна ${weight.delta} кг — ${dir})`);
    } else {
      lines.push(`- Текущо тегло: ${weight.current} кг (няма история за прогрес)`);
    }
  }

  return { facts: lines.join('\n'), profile, weekly, weight };
}

async function callAI(openai, { system, user, maxTokens = 500, temperature = 0.85 }) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature,
  });
  const text = completion.choices[0]?.message?.content?.trim() ?? '';
  // Coaching/motivation/plan output is always content-first by design, so any
  // leading greeting the model adds is unwanted regardless of timing.
  return stripLeadingGreeting(text);
}

function normalize(s) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Generate a motivational message that is guaranteed never to be an exact
// duplicate of a previously sent one, then persist it (unless persist=false,
// e.g. for the owner, whose data must never enter user memory).
async function generateUniqueMotivation(openai, userId, { system, user, persist = true }) {
  const prior = persist ? getSentMotivations(userId) : [];
  const priorNorm = new Set(prior.map(normalize));
  const avoidBlock = prior.length
    ? `\n\nВАЖНО: НЕ повтаряй и не перифразирай близко следните вече използвани послания:\n` +
      prior.slice(-12).map((m, i) => `${i + 1}. ${m}`).join('\n')
    : '';

  let text = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    text = await callAI(openai, {
      system: system + avoidBlock,
      user,
      temperature: 0.9 + attempt * 0.15,
    });
    if (text && !priorNorm.has(normalize(text))) break;
  }

  // Deterministic guarantee: if the model still produced a duplicate after the
  // retries, append a strictly-increasing, on-brand tail so the full message is
  // never byte-for-byte identical to a previous one.
  if (text && priorNorm.has(normalize(text))) {
    const day = prior.length + 1;
    text = `${text}\n\nДен ${day} от твоето пътуване към по-здравословен живот. 🌱`;
  }

  if (text && persist) addSentMotivation(userId, text);
  return text;
}

async function generateCoach(openai, userId, { persist = true } = {}) {
  const { facts } = buildCoachingFacts(userId);
  const system =
    `${SYSTEM_PROMPT}\n\n${facts}\n\n` +
    'Ти си личен коуч. Напиши кратко дневно коучинг послание (3–5 изречения): ' +
    'отбележи нещо конкретно от напредъка, дай топло насърчение и една ясна насока за деня. ' +
    'Говори лично, на „ти“, в топлия тон на Ели.';
  return generateUniqueMotivation(openai, userId, {
    system,
    user: 'Дай ми днешното коучинг послание.',
    persist,
  });
}

async function generateMotivate(openai, userId, { persist = true } = {}) {
  const { facts } = buildCoachingFacts(userId);
  const system =
    `${SYSTEM_PROMPT}\n\n${facts}\n\n` +
    'Напиши едно уникално, свежо мотивационно послание (2–4 изречения), ' +
    'съобразено с личността, целта и характера на този потребител. ' +
    'Бъди оригинална и сърдечна — избягвай клишета и не звучи като предишните послания.';
  return generateUniqueMotivation(openai, userId, {
    system,
    user: 'Мотивирай ме.',
    persist,
  });
}

async function generateNextStep(openai, userId) {
  const { facts } = buildCoachingFacts(userId);
  const system =
    `${SYSTEM_PROMPT}\n\n${facts}\n\n` +
    'Дай ТОЧНО ЕДНА малка, конкретна и изпълнима днес стъпка, съобразена с най-слабата област ' +
    'от напредъка на потребителя. Само една стъпка, кратко и ясно, с топъл тон. ' +
    'Започни с „Днешната ти стъпка:“ и я направи лесна за изпълнение.';
  return callAI(openai, {
    system,
    user: 'Коя е моята една стъпка за днес?',
    maxTokens: 250,
    temperature: 0.8,
  });
}

async function generateWeeklyReview(openai, userId) {
  const { facts, weekly } = buildCoachingFacts(userId);
  if (!weekly || weekly.count === 0) {
    return null; // caller handles the "no data" case
  }
  const system =
    `${SYSTEM_PROMPT}\n\n${facts}\n\n` +
    'Направи преглед на последните 7 дни. Използвай точните числа от данните по-горе. ' +
    'Структурирай отговора с тези раздели, всеки с емоджи и кратък личен коментар:\n' +
    '🏆 Победи\n❌ Пропуснати навици\n🏋️ Постоянство с тренировки\n🥗 Постоянство с храненето\n' +
    '💧 Хидратация\n😴 Сън\n⚖️ Прогрес с теглото\n\n' +
    'Завърши с кратко насърчение и една препоръка за следващата седмица. Топъл тон на Ели.';
  return callAI(openai, {
    system,
    user: 'Направи ми седмичния преглед.',
    maxTokens: 900,
    temperature: 0.7,
  });
}

module.exports = {
  buildCoachingFacts,
  computeWeekly,
  computeWeightProgress,
  generateCoach,
  generateMotivate,
  generateNextStep,
  generateWeeklyReview,
};
