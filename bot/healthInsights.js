// Deterministic, supportive health insights built ONLY from the user's stored
// profile and daily logs. No AI call, no diagnosis, no medical certainty — just
// gentle, educational feedback and general lifestyle guidance.
//
//   - feedbackForEvents(userId, events): a brief, personalized note right after
//     something is recorded (water / sleep / workout / weight / meal / steps).
//   - overallInsight(userId): the "How am I doing?" summary over recent data,
//     or a polite "need more data" message when there isn't enough yet.
const { getToday, getRange } = require('./dailyLogStorage');
const { getWeightLog } = require('./memoryStorage');
const { getUser } = require('./storage');
// Wellness (not medical) disclaimer lives in the centralized persona so the
// exact wording is identical on every route that gives health guidance.
const { DISCLAIMER } = require('./persona');

const DAY_MS = 24 * 60 * 60 * 1000;

// A recent-data snapshot needs at least this many distinct days before Eli
// offers personalized insights (otherwise she asks for more info).
const MIN_DAYS_FOR_INSIGHT = 2;

function round1(n) {
  return Math.round(n * 10) / 10;
}

function byCategory(entries, category) {
  return entries.filter((e) => e.category === category);
}

// Rough conversion of a water amount to litres so different units can be
// compared against a general hydration guideline. Deliberately approximate.
function toLitres(amount, unit) {
  if (typeof amount !== 'number' || isNaN(amount)) return 0;
  if (unit === 'чаши') return amount * 0.25;
  if (unit === 'мл') return amount / 1000;
  if (unit === 'л') return amount;
  return 0;
}

function waterLitresToday(userId) {
  return byCategory(getToday(userId), 'water').reduce(
    (sum, e) => sum + toLitres(e.amount, e.unit),
    0
  );
}

// Detect the direction of the user's goal from the free-text profile field so
// weight feedback can be framed helpfully. Returns 'lose' | 'gain' | null.
function goalDirection(profile) {
  const g = String(profile?.goal || '').toLowerCase();
  if (!g) return null;
  if (/(отслабв|свал|намал|отслабна|редукц|weight loss|lose)/.test(g)) return 'lose';
  if (/(качв|маса|напълн|мускул|gain|bulk|muscle)/.test(g)) return 'gain';
  return null;
}

// ── Per-event feedback (shown right after recording) ─────────────────────────

function waterFeedback(userId) {
  const litres = waterLitresToday(userId);
  if (litres <= 0) return '💧 Отбелязах водата ти. Малките глътки през деня помагат да останеш хидратиран/а.';
  if (litres < 1) {
    return `💧 Досега днес: около ${round1(litres)} л. Добро начало — целѝ се плавно към ~2 л през деня. 😊`;
  }
  if (litres <= 3) {
    return `💧 Досега днес: около ${round1(litres)} л. Браво, движиш се в добрия диапазон за хидратация! 👏`;
  }
  return `💧 Досега днес: около ${round1(litres)} л — това е доста вода. Слушай тялото си и пий според жаждата. 😊`;
}

function sleepFeedback(events) {
  const sleep = events.filter((e) => e.category === 'sleep').pop();
  const h = sleep && typeof sleep.amount === 'number' ? sleep.amount : null;
  if (h == null) return '😴 Записах съня ти. Постоянният режим на сън помага за енергията през деня.';
  if (h < 6) {
    return `😴 ${round1(h)} ч е малко под комфортното. Повечето възрастни се чувстват най-добре при 7–9 ч — опитай да си легнеш малко по-рано тази вечер. 🌙`;
  }
  if (h <= 9) {
    return `😴 ${round1(h)} ч — чудесно, това е в здравословния диапазон за възстановяване! 🌙`;
  }
  return `😴 ${round1(h)} ч е доста сън. Ако все пак се чувстваш уморен/а, помисли за режима и качеството на съня. 😊`;
}

function workoutFeedback(userId) {
  const trainedDays = new Set(byCategory(getRange(userId, 7), 'workout').map((e) => e.date));
  const n = trainedDays.size;
  if (n <= 1) {
    return '🏋️ Супер, че помръдна! Дори 2–3 активни дни в седмицата правят голяма разлика. 💪';
  }
  if (n <= 3) {
    return `🏋️ Това са ${n} активни дни през последната седмица — страхотна постоянство! 💪`;
  }
  return `🏋️ Вече ${n} активни дни за седмицата — браво! Не забравяй и ден за възстановяване. 🙌`;
}

function weightFeedback(userId) {
  const log = getWeightLog(userId);
  if (log.length < 2) {
    return '⚖️ Записах теглото ти. С още няколко измервания ще мога да ти покажа и тенденцията. 😊';
  }
  const last = log[log.length - 1].weight;
  const prev = log[log.length - 2].weight;
  const diff = round1(last - prev);
  const dir = goalDirection(getUser(userId));
  if (Math.abs(diff) < 0.3) {
    return `⚖️ Теглото ти е стабилно спрямо предишното измерване (${last} кг). Малките колебания ден за ден са напълно нормални. 😊`;
  }
  const changed = diff < 0 ? `надолу с ${Math.abs(diff)} кг` : `нагоре с ${Math.abs(diff)} кг`;
  const aligned =
    (dir === 'lose' && diff < 0) || (dir === 'gain' && diff > 0);
  if (dir && aligned) {
    return `⚖️ ${last} кг — движение ${changed} спрямо предишното. Това е в посоката на целта ти, браво! 👏 Постоянството е по-важно от бързината.`;
  }
  return `⚖️ ${last} кг — промяна ${changed} спрямо предишното измерване. Дневните колебания са нормални; тенденцията за седмици говори повече от единично число. 😊`;
}

// Keyword groups for a lightweight, deterministic nutrition read of a meal.
const PROTEIN_RE =
  /(пил[еeе]шк|пиле|месо|говежд|телешк|свинск|риба|сьомга|туна|тон(?![а-яa-z])|яйц|яйца|омлет|извара|сирене|кашкавал|кисело мляко|боб|леща|нахут|киноа|протеин|пуйк|скарид|морск|шунк|кайма|кюфте|стек)/;
const VEG_RE =
  /(салат|зеленчуц|домат|краставиц|броколи|спанак|зеле|морков|чушк|тиквичк|гъб|авокадо|рукол|марул|зелен|аспержи|карфиол|тиква)/;
const FRUIT_RE =
  /(ябълк|банан|портокал|плод|горск|ягод|боровинк|грозде|киви|круш|праскова|мандарин|нар(?![а-яa-z])|пъпеш|диня|смути)/;
const CARB_RE =
  /(ориз|картоф|хляб|тестен|паста|макарон|овес|булгур|кускус|пълнозърнест|мюсли|корнфлейкс|филия|питк)/;
const SWEET_RE =
  /(торт|сладк|шоколад|бисквит|захар|понич|вафл|десерт|сладолед|кроасан|курабий|бонбон)/;

// Approx. litres of water logged in `entries` (same conversion as the service).
function waterLitres(entries) {
  let litres = 0;
  for (const e of entries) {
    if (e.category !== 'water' || typeof e.amount !== 'number') continue;
    if (e.unit === 'чаши') litres += e.amount * 0.25;
    else if (e.unit === 'л') litres += e.amount;
    else if (e.unit === 'мл') litres += e.amount / 1000;
  }
  return litres;
}

function mealFeedback(userId, events) {
  const today = getToday(userId);
  const meal = (events || []).filter((e) => e.category === 'meal').pop();
  const text = String(meal?.value || '').toLowerCase();

  const hasProtein = PROTEIN_RE.test(text);
  const hasVeg = VEG_RE.test(text);
  const hasFruit = FRUIT_RE.test(text);
  const hasCarb = CARB_RE.test(text);
  const hasSweet = SWEET_RE.test(text);

  let comment;
  if (hasProtein && hasVeg) {
    comment = 'Балансирано — има и протеин, и зеленчуци. 👏';
  } else if (hasProtein && !hasVeg) {
    comment = 'Добър източник на протеин! 💪 Добави и малко зеленчуци за повече фибри и ситост. 🥦';
  } else if (!hasProtein && hasVeg) {
    comment = 'Чудесно със зеленчуците! 🥗 Добави и протеин (яйца, пиле, риба, извара, боб), за да засищаш по-дълго.';
  } else if (hasFruit && !hasCarb) {
    comment = 'Плодовете са добър избор. 🍎 За по-засищащо хранене добави протеин и зеленчуци.';
  } else if (hasSweet && !hasProtein) {
    comment = 'Сладкото е ок в мярка. 🙂 През деня го балансирай с протеин и зеленчуци.';
  } else if (hasCarb && !hasProtein && !hasVeg) {
    comment = 'Добре е да добавиш протеин и зеленчуци към въглехидратите за баланс. 🥗';
  } else {
    comment = 'Опитай всяко хранене да съчетава протеин, зеленчуци и пълнозърнести — така засищаш по-дълго. 🥗';
  }

  // Low-water reminder only when it's relevant (little logged so far today).
  const waterNote = waterLitres(today) < 1 ? ' И не забравяй водата днес — засега имаш малко записана. 💧' : '';

  return `🍽️ Записах храненето ти. ${comment}${waterNote}`;
}

function stepsFeedback(userId) {
  const total = byCategory(getToday(userId), 'steps').reduce((s, e) => s + (e.amount || 0), 0);
  if (total <= 0) return '👟 Записах стъпките ти. Всяка разходка се брои! 🙂';
  if (total < 5000) {
    return `👟 ${total} стъпки днес — добро начало. Кратка разходка може лесно да ги увеличи. 🙂`;
  }
  if (total < 8000) {
    return `👟 ${total} стъпки днес — движиш се добре! Продължавай така. 👏`;
  }
  return `👟 ${total} стъпки днес — страхотна активност! 🎉`;
}

const EVENT_FEEDBACK = {
  water: (userId) => waterFeedback(userId),
  sleep: (userId, events) => sleepFeedback(events),
  workout: (userId) => workoutFeedback(userId),
  weight: (userId) => weightFeedback(userId),
  meal: (userId, events) => mealFeedback(userId, events),
  steps: (userId) => stepsFeedback(userId),
};

// Brief, personalized feedback for the categories just recorded. Deduped and
// kept short so it reads like an encouraging note, not a report.
function feedbackForEvents(userId, events) {
  const seen = new Set();
  const lines = [];
  for (const ev of events) {
    if (seen.has(ev.category)) continue;
    seen.add(ev.category);
    const fn = EVENT_FEEDBACK[ev.category];
    if (fn) lines.push(fn(userId, events));
  }
  if (!lines.length) return '';
  return `💡 *Ели забелязва:*\n${lines.join('\n')}`;
}

// ── Overall insight ("How am I doing?") ──────────────────────────────────────

function overallInsight(userId) {
  const entries = getRange(userId, 7);
  const daysWithData = new Set(entries.map((e) => e.date)).size;
  const profile = getUser(userId);
  const name = profile?.firstName ? `, ${profile.firstName}` : '';

  if (daysWithData < MIN_DAYS_FOR_INSIGHT) {
    return (
      `📭 Още нямам достатъчно данни за личен анализ${name}.\n\n` +
      'Разкажи ми през следващите дни колко вода пиеш, какво хапваш, кога тренираш, ' +
      'колко спиш и колко тежиш — след няколко дни ще мога да ти дам смислена обратна връзка. 😊'
    );
  }

  const water = byCategory(entries, 'water');
  const waterDays = new Set(water.map((e) => e.date)).size;
  const workouts = byCategory(entries, 'workout');
  const trainedDays = new Set(workouts.map((e) => e.date)).size;
  const meals = byCategory(entries, 'meal');
  const mealDays = new Set(meals.map((e) => e.date)).size;
  const sleep = byCategory(entries, 'sleep');
  const steps = byCategory(entries, 'steps');
  const weightLog = getWeightLog(userId);

  const lines = [`📊 *Как се справяш${name}* (последните 7 дни)`, `📅 Дни със записи: ${daysWithData}`, ''];

  // Hydration
  if (waterDays) {
    if (waterDays >= Math.max(2, daysWithData - 1)) {
      lines.push(`💧 Хидратация: пиеш вода почти всеки ден (${waterDays} дни) — чудесен навик! 👏`);
    } else {
      lines.push(`💧 Хидратация: вода в ${waterDays} от ${daysWithData} дни. Дребна цел: чаша вода със всяко хранене. 😊`);
    }
  }

  // Activity
  if (trainedDays) {
    const note =
      trainedDays >= 3
        ? 'страхотна постоянство!'
        : 'всяка тренировка се брои — целѝ се плавно към 3 пъти седмично.';
    lines.push(`🏋️ Активност: ${trainedDays} тренировъчни дни — ${note} 💪`);
  } else {
    lines.push('🏋️ Активност: още няма записана тренировка тази седмица. Дори кратка разходка е чудесно начало. 🙂');
  }

  if (steps.length) {
    const avg = Math.round(
      steps.reduce((s, e) => s + (e.amount || 0), 0) / new Set(steps.map((e) => e.date)).size
    );
    lines.push(`👟 Стъпки: средно ~${avg} на активен ден.`);
  }

  // Sleep
  if (sleep.length) {
    const avg = round1(sleep.reduce((s, e) => s + (e.amount || 0), 0) / sleep.length);
    let note;
    if (avg < 6) note = 'малко под комфортното — опитай да си лягаш по-рано.';
    else if (avg <= 9) note = 'точно в здравословния диапазон, браво!';
    else note = 'доста сън — важно е и качеството, не само часовете.';
    lines.push(`😴 Сън: средно ${avg} ч — ${note}`);
  }

  // Nutrition
  if (mealDays) {
    lines.push(
      `🍽️ Хранене: записал/а си хранения в ${mealDays} дни. Баланс = протеин + зеленчуци + пълнозърнести във всяко хранене. 🥗`
    );
  }

  // Weight trend — scoped to the same recent 7-day window as the rest of the
  // summary, so old historical weigh-ins don't distort "recent progress".
  const recentWeights = weightLog.filter(
    (w) => Date.now() - new Date(w.date).getTime() <= 7 * DAY_MS
  );
  if (recentWeights.length >= 2) {
    const last = recentWeights[recentWeights.length - 1].weight;
    const first = recentWeights[0].weight;
    const diff = round1(last - first);
    const dir = goalDirection(profile);
    if (Math.abs(diff) < 0.3) {
      lines.push(`⚖️ Тегло: стабилно около ${last} кг тази седмица. Малките колебания са нормални. 😊`);
    } else {
      const moved = diff < 0 ? `надолу с ${Math.abs(diff)} кг` : `нагоре с ${Math.abs(diff)} кг`;
      const aligned = (dir === 'lose' && diff < 0) || (dir === 'gain' && diff > 0);
      lines.push(
        `⚖️ Тегло: ${last} кг (${moved} за последните 7 дни)${aligned ? ' — в посоката на целта ти, браво! 👏' : '. Тенденцията за седмици казва повече от едно число.'}`
      );
    }
  } else if (recentWeights.length === 1) {
    lines.push(`⚖️ Тегло: ${recentWeights[recentWeights.length - 1].weight} кг. С още измервания ще видим и тенденцията. 😊`);
  }

  lines.push('');
  lines.push('Продължавай с малките ежедневни стъпки — те правят голямата промяна. 💪');
  lines.push('');
  lines.push(DISCLAIMER);
  return lines.join('\n');
}

module.exports = {
  feedbackForEvents,
  overallInsight,
};
