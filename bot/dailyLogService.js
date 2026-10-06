// Deterministic formatting + recording for the daily health log. Every answer
// here is built ONLY from stored entries — Eli never guesses these values.
const { addEntry, getToday, getDay, getRange, todayKey } = require('./dailyLogStorage');
const { addWeightEntry } = require('./memoryStorage');
const {
  CATEGORY_META,
  matchCategoryQuery,
  answerCategory,
  byCategory,
  sumWater,
  round1,
} = require('./dailyLogQuery');
const { overallInsight } = require('./healthInsights');
const { getUser } = require('./storage');
const { pick, CONFIRM_OPENERS } = require('./persona');

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Persist a batch of parsed events. A reported weight also feeds the existing
// weight-progress log so coaching stays in sync.
function recordEvents(userId, events) {
  const recorded = [];
  for (const ev of events) {
    recorded.push(addEntry(userId, ev));
    if (ev.category === 'weight' && typeof ev.amount === 'number') {
      addWeightEntry(userId, ev.amount);
    }
  }
  // Verify persistence: re-read each entry's own date from storage and confirm
  // it is actually there before callers rely on it. Reading per-entry date
  // (not just getToday) avoids a false failure for a turn that crosses midnight.
  const persisted = recorded.every((r) => {
    const stored = getDay(userId, r.date);
    return stored.some((s) => s.at === r.at && s.category === r.category && s.value === r.value);
  });
  if (!persisted) {
    throw new Error('daily log verification failed: entries not found after save');
  }
  return recorded;
}

// Short confirmation shown right after auto-recording. The opener is rotated
// (seeded by how many things were logged) so Eli doesn't say the exact same
// line every time — the wording variants live in the centralized persona.
function formatConfirmation(events) {
  const lines = events.map((ev) => {
    const meta = CATEGORY_META[ev.category];
    return `${meta.emoji} ${meta.label}: ${ev.value}`;
  });
  // Seed with a minute-bucketed clock + how many things were logged so the
  // opener actually rotates between logs (not fixed for every single-item save).
  const seed = Math.floor(Date.now() / 60000) + events.length;
  return `${pick(CONFIRM_OPENERS, seed)}\n${lines.join('\n')}`;
}

function answerTodaySummary(userId) {
  const entries = getToday(userId);
  if (!entries.length) {
    return (
      `📭 *Днес (${todayKey()})* все още няма записани данни.\n\n` +
      'Сподели какво пи, яде, тренира, колко спа или колко тежиш — и ще го запиша автоматично. 😊'
    );
  }

  const lines = [`📋 *Обобщение за днес (${todayKey()})*`, ''];

  const water = sumWater(entries);
  if (water) lines.push(`💧 Вода: ${water}`);

  const meals = byCategory(entries, 'meal');
  if (meals.length) {
    lines.push(`🍽️ Хранения (${meals.length}):`);
    meals.forEach((m) => lines.push(`   • ${m.time} — ${m.value}`));
  }

  const workouts = byCategory(entries, 'workout');
  if (workouts.length) {
    lines.push(`🏋️ Тренировки: ${workouts.map((w) => w.value).join(', ')}`);
  }

  const sleep = byCategory(entries, 'sleep');
  if (sleep.length) lines.push(`😴 Сън: ${sleep[sleep.length - 1].value}`);

  const weight = byCategory(entries, 'weight');
  if (weight.length) lines.push(`⚖️ Тегло: ${weight[weight.length - 1].value}`);

  const steps = byCategory(entries, 'steps');
  if (steps.length) {
    const total = steps.reduce((s, e) => s + (e.amount || 0), 0);
    lines.push(`👟 Стъпки: ${total}`);
  }

  return lines.join('\n');
}

// Rough litre estimate so hydration tips can react to today's total regardless
// of the unit the user reported in (чаши/л/мл can't otherwise be merged).
function waterLitres(entries) {
  let l = 0;
  for (const e of byCategory(entries, 'water')) {
    if (typeof e.amount !== 'number') continue;
    if (e.unit === 'чаши') l += e.amount * 0.25;
    else if (e.unit === 'л') l += e.amount;
    else if (e.unit === 'мл') l += e.amount / 1000;
  }
  return l;
}

// Pick verb forms matching the user's stated gender; fall back to the "/а"
// form the rest of the bot uses when gender is unknown or unshared.
function genderedVerbs(profile) {
  const g = profile?.gender;
  if (g === 'Жена') return { drank: 'изпила', trained: 'тренирала', slept: 'спала' };
  if (g === 'Мъж') return { drank: 'изпил', trained: 'тренирал', slept: 'спал' };
  return { drank: 'изпил/а', trained: 'тренирал/а', slept: 'спал/а' };
}

// Join clauses naturally: "A", "A и B", "A, B и C".
function joinNatural(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} и ${parts[parts.length - 1]}`;
}

// Today-focused, supportive progress summary in natural Bulgarian. Reads only
// stored entries + profile — never guesses. Names what's recorded, gives brief
// encouragement + a tip, and mentions missing core habits without sounding robotic.
function answerProgressToday(userId) {
  const entries = getToday(userId);
  const profile = getUser(userId);
  const name = profile?.firstName ? ` ${profile.firstName}` : '';
  const v = genderedVerbs(profile);

  if (!entries.length) {
    return (
      `Днес още нямам записани данни за теб${name}. ` +
      'Разкажи ми какво пи, яде, тренира или колко спа — и веднага ще започна да следя деня ти. 😊'
    );
  }

  const water = sumWater(entries);
  const litres = waterLitres(entries);
  const workouts = byCategory(entries, 'workout');
  const sleep = byCategory(entries, 'sleep');
  const meals = byCategory(entries, 'meal');
  const weight = byCategory(entries, 'weight');
  const steps = byCategory(entries, 'steps');

  const recorded = [];
  if (water) recorded.push(`си ${v.drank} ${water} вода`);
  if (workouts.length) {
    const details = workouts
      .map((w) => {
        const m = String(w.value).match(/^Тренировка\s*\((.+)\)$/);
        return m ? m[1] : String(w.value);
      })
      .filter((d) => d && d !== 'Тренировка');
    recorded.push(details.length ? `си ${v.trained} ${details.join(', ')}` : `си ${v.trained}`);
  }
  if (sleep.length) recorded.push(`си ${v.slept} ${sleep[sleep.length - 1].value}`);
  if (meals.length) {
    recorded.push(meals.length === 1 ? 'имаш едно записано хранене' : `имаш ${meals.length} записани хранения`);
  }
  if (weight.length) recorded.push(`тегло ${weight[weight.length - 1].value}`);
  if (steps.length) {
    const total = steps.reduce((s, e) => s + (e.amount || 0), 0);
    recorded.push(`${total} стъпки`);
  }

  // Core daily habits we gently flag when missing (weight/steps aren't daily,
  // so we don't nag about them).
  const missing = [];
  if (!water) missing.push('вода');
  if (!workouts.length) missing.push('тренировка');
  if (!sleep.length) missing.push('сън');
  if (!meals.length) missing.push('хранене');

  // Improvement tips based on what the stored numbers actually show.
  const tips = [];
  if (litres > 0 && litres < 2) tips.push('изпиеш още вода');
  if (sleep.length) {
    const h = sleep[sleep.length - 1].amount;
    if (typeof h === 'number' && h < 7) tips.push('се стремиш към поне 7 часа сън');
  }
  if (!workouts.length) tips.push('вмъкнеш малко движение, дори кратка разходка');

  const corePresent = [water ? 1 : 0, workouts.length ? 1 : 0, sleep.length ? 1 : 0, meals.length ? 1 : 0].reduce(
    (a, b) => a + b,
    0
  );

  const out = [];
  out.push(`Днес се справяш добре${name}.`);
  if (recorded.length) out.push(`Имам записано, че ${joinNatural(recorded)}.`);
  out.push(corePresent >= 3 ? 'Браво, поддържаш добър ритъм! 💪' : 'Добро начало.');
  if (tips.length) out.push(`Можеш да подобриш деня си, ако ${joinNatural(tips)}.`);
  if (missing.length) out.push(`Нямам записано ${joinNatural(missing)} за днес.`);

  return out.join(' ');
}

function answerWeekProgress(userId) {
  const entries = getRange(userId, 7);
  if (!entries.length) {
    return (
      '📭 През последните 7 дни няма записани данни.\n\n' +
      'Започни да ми казваш какво пиеш, ядеш и тренираш — и ще follow-вам напредъка ти всеки ден. 😊'
    );
  }

  const dates = new Set(entries.map((e) => e.date));
  const waterDays = new Set(byCategory(entries, 'water').map((e) => e.date));
  const workouts = byCategory(entries, 'workout');
  const trainedDays = new Set(workouts.map((e) => e.date));
  const meals = byCategory(entries, 'meal');
  const sleep = byCategory(entries, 'sleep');
  const steps = byCategory(entries, 'steps');
  const weight = byCategory(entries, 'weight');

  const lines = [`📊 *Прогрес за последните 7 дни*`, `📅 Дни със записи: ${dates.size}`, ''];

  lines.push(`💧 Дни с вода: ${waterDays.size}`);
  lines.push(`🏋️ Тренировки: ${workouts.length} (в ${trainedDays.size} дни)`);
  lines.push(`🍽️ Записани хранения: ${meals.length}`);

  if (sleep.length) {
    const avg = round1(sleep.reduce((s, e) => s + (e.amount || 0), 0) / sleep.length);
    lines.push(`😴 Среден сън: ${avg} ч (${sleep.length} записа)`);
  }

  if (steps.length) {
    const total = steps.reduce((s, e) => s + (e.amount || 0), 0);
    lines.push(`👟 Общо стъпки: ${total}`);
  }

  if (weight.length) {
    const last = weight[weight.length - 1];
    lines.push(`⚖️ Последно тегло: ${last.value} (${last.date})`);
  }

  return lines.join('\n');
}

// ── Top-level query resolution ──────────────────────────────────────────────
// Coaching-summary intents (a supportive day recap, a 7-day report, deeper
// health insights). Ordered most-specific-first. These are richer, multi-metric
// answers, so they are matched BEFORE single-category retrieval.
const SUMMARY_PATTERNS = [
  ['progress_summary', [
    /как се справям/,
    /как (се )?вървя/,
    /как върви (режим|деня|денят|програмата|планът|плана|всичко при мен)/,
    /какъв( ми)? е( моят| ми)? (прогрес|напредък)/,
    /как (е|върви|се движи) (моят |ми )?(напредък|прогрес)/,
    /(дай|дай ми|искам|може ли)( едно| кратко| набързо)? обобщени(е|ето)/,
    /обобщи( ми)? (деня|денят)( ми)?/,
    /как съм днес/,
    /how('?m| am| are)\s+i\s+doing/,
    /(daily )?progress today/,
  ]],
  ['how_am_i_doing', [
    /как съм (със|общо|досега|напоследък|със здравето)/,
    /(дай ми|покажи ми|искам) (здравен )?(анализ|обратна връзка|insight)/,
    /здравен анализ/,
    /health insights?/,
    /give me (a )?(health )?(insight|feedback)/,
  ]],
  ['week_progress', [
    /(седмичн|тази седмица|последната седмица|за седмицата|изминалата седмица).*(прогрес|напредък|обобщени|резюме|как)/,
    /(прогрес|напредък).*(седмица|седмичн)/,
    /this week'?s?\s+progress/,
    /(progress|summary).*this week/,
    /как (мина|беше) седмицата/,
  ]],
  ['today_summary', [
    /(обобщени[ето]*|резюме).*(за )?днес/,
    /обобщи.*(днес|деня|данни)/,
    /(покажи|дай|дай ми).*(данни|дневник|записа).*(днес|деня)/,
    /today'?s?\s+summary/,
    /(покажи|show).*(дневник|log).*(днес|today)/,
    /дневник(а|ът)?\s+за\s+днес/,
  ]],
];

// Generic "what did I log/record today" that names no single category → the
// full day summary rather than a single metric.
const LOGISH_RE =
  /(дневник|записа[хл]|логна|обобщ|what.*(did|have) i.*(log|record|track)|what did i log)/;

function matchSummary(t) {
  for (const [type, patterns] of SUMMARY_PATTERNS) {
    if (patterns.some((re) => re.test(t))) return type;
  }
  return null;
}

// Single entry point used by the bot before it ever calls the LLM. Returns a
// descriptor ({ kind:'summary'|'category', ... }) when the message is asking
// about stored health data, or null when it is not. Because the caller checks
// this first and returns on a hit, the model can NEVER answer a data question
// before storage has been consulted.
function resolveLogQuery(text) {
  const t = normalize(text);
  if (!t) return null;

  const summaryType = matchSummary(t);
  if (summaryType) return { kind: 'summary', type: summaryType };

  const category = matchCategoryQuery(text);
  if (category) return { kind: 'category', ...category };

  if (LOGISH_RE.test(t)) return { kind: 'summary', type: 'today_summary' };

  return null;
}

// Route a resolved descriptor to its deterministic, storage-backed answer.
function answerDailyLogQuery(userId, descriptor) {
  if (!descriptor) return answerTodaySummary(userId);
  if (descriptor.kind === 'category') return answerCategory(userId, descriptor);

  switch (descriptor.type) {
    case 'progress_summary':
      return answerProgressToday(userId);
    case 'week_progress':
      return answerWeekProgress(userId);
    case 'how_am_i_doing':
      return overallInsight(userId);
    case 'today_summary':
    default:
      return answerTodaySummary(userId);
  }
}

module.exports = {
  recordEvents,
  formatConfirmation,
  resolveLogQuery,
  answerDailyLogQuery,
  answerTodaySummary,
  answerProgressToday,
  answerWeekProgress,
};
