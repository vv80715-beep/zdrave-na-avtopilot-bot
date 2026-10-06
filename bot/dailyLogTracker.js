// Deterministic WRITE-parsing layer for the daily health log.
//   - extractHealthEvents(text): finds reported water/meals/workouts/sleep/
//     weight/steps in a free-text (or transcribed voice) message.
// Reading/answering questions about the log lives in dailyLogQuery.js (routing)
// and dailyLogService.js (orchestration). Everything here is regex-based: no AI
// call, so it is fast, free and testable.

const { isAdviceRequest } = require('./dailyLogQuery');

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function num(str) {
  return parseFloat(String(str).replace(',', '.'));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ── Water ─────────────────────────────────────────────────────────────────
function normalizeWaterUnit(u) {
  if (/^(чаши|чаша|glass|glasses)$/.test(u)) return 'чаши';
  if (/^(литра|литър|литри|л|liter|liters|litre|litres)$/.test(u)) return 'л';
  if (/^(мл|ml)$/.test(u)) return 'мл';
  return u;
}

function extractWater(t) {
  if (!/(вода|water)/.test(t)) return null;
  const m = t.match(
    /(\d+(?:[.,]\d+)?)\s*(чаши|чаша|литра|литър|литри|л|мл|ml|glasses|glass|liters|liter|litres|litre)(?![а-яa-z])/
  );
  if (!m) return null;
  const amount = num(m[1]);
  if (isNaN(amount)) return null;
  const unit = normalizeWaterUnit(m[2]);
  return { category: 'water', amount, unit, value: `${round1(amount)} ${unit}` };
}

// ── Sleep ─────────────────────────────────────────────────────────────────
// Handles hours plus optional minutes: "7 часа", "7 часа и 30 минути",
// "6 часа и половина" (=30 min), "8 часа и 15 минути". `amount` keeps the exact
// duration in decimal hours (so averaging/feedback stay precise); `value` is the
// human "H ч M мин" string used in summaries. Minutes are never discarded.
function extractSleep(t) {
  const m = t.match(
    /(?:спах|поспах|сън(?:ят)?|slept|sleep)[^\d]{0,15}(\d+(?:[.,]\d+)?)\s*(часа|час|ч|hours|hour|hrs|hr|h)(?![а-яa-z])/
  );
  if (!m) return null;
  const hours = num(m[1]);
  if (isNaN(hours)) return null;

  // Minutes must directly continue the hours ("7 часа и 30 минути", "6 часа и
  // половина"), so both patterns are anchored to the start of the remaining
  // text. This stops unrelated later durations (e.g. "...после тренирах 20
  // минути") from being misread as sleep minutes.
  const rest = t.slice(m.index + m[0].length);
  let minutes = 0;
  if (/^[\s,.–—-]*и\s*половина/.test(rest)) {
    minutes = 30;
  } else {
    const mm = rest.match(/^[\s,.–—-]*(?:и\s*)?(\d+)\s*(?:минути|минута|мин|minutes|minute|min)(?![а-яa-z])/);
    if (mm) {
      const val = parseInt(mm[1], 10);
      if (!isNaN(val) && val >= 0 && val < 60) minutes = val;
    }
  }

  // Fold everything into exact decimal hours, then re-split for display so a
  // fractional input like "7.5 часа" also renders as "7 ч 30 мин".
  const totalHours = Math.round((hours + minutes / 60) * 100) / 100;
  const h = Math.floor(totalHours + 1e-9);
  const min = Math.round((totalHours - h) * 60);
  const value = min > 0 ? `${h} ч ${min} мин` : `${h} ч`;

  return { category: 'sleep', amount: totalHours, unit: 'ч', value };
}

// ── Weight ────────────────────────────────────────────────────────────────
function extractWeight(t) {
  const m = t.match(
    /(?:тежа|тегло(?:то)?(?:\s*ми)?(?:\s*е)?|качих се на|weigh|weight(?:\s*is)?|my weight)[^\d]{0,12}(\d+(?:[.,]\d+)?)\s*(кг|килограма|kg|kilos|kilo)?(?![а-яa-z])/
  );
  if (!m) return null;
  const amount = num(m[1]);
  if (isNaN(amount) || amount < 20 || amount > 400) return null;
  return { category: 'weight', amount, unit: 'кг', value: `${round1(amount)} кг` };
}

// ── Steps ─────────────────────────────────────────────────────────────────
function extractSteps(t) {
  // "дай ми 3 стъпки как да…" = instructional steps, never pedometer data —
  // the same advice detector that keeps such requests out of read queries.
  if (isAdviceRequest(t)) return null;
  const m = t.match(/(\d[\d\s]*)\s*(стъпки|крачки|steps)(?![а-яa-z])/);
  if (!m) return null;
  const amount = parseInt(m[1].replace(/\s/g, ''), 10);
  if (isNaN(amount)) return null;
  return { category: 'steps', amount, unit: 'стъпки', value: `${amount} стъпки` };
}

// ── Workout ───────────────────────────────────────────────────────────────
const WORKOUT_RE =
  /(тренирах|тренирал[аи]?|бягах|тичах|плувах|карах колело|въртях педали|ходих на фитнес|бях на фитнес|бях на тренировка|направих тренировка|разходих се|worked out|work ?out|went to the gym|did a workout|i trained|i ran|jogged|swam|exercised)/;

function extractWorkout(t) {
  if (!WORKOUT_RE.test(t)) return null;
  const dur = t.match(/(\d+(?:[.,]\d+)?)\s*(минути|минута|мин|min|minutes|часа|час|ч|hours|hour|h)(?![а-яa-z])/);
  let value = 'Тренировка';
  if (dur) {
    const unit = /мин|min/.test(dur[2]) ? 'мин' : 'ч';
    value = `Тренировка (${round1(num(dur[1]))} ${unit})`;
  }
  return { category: 'workout', amount: null, unit: null, value };
}

// ── Meals ─────────────────────────────────────────────────────────────────
// One message can report several meals at once ("Закусих X. Обядвах Y. Изядох
// Z."), so we find EVERY meal verb and split the text at each one. Cyrillic \b
// is unreliable in JS, so word edges use (?<![а-яa-z]) / (?![а-яa-z]) lookarounds.
// Longer/prefixed verbs are listed before their substrings (наядох се > ядох,
// похапнах > хапнах, изядох > ядох) so the right verb wins at each position.
const MEAL_VERB_SOURCE =
  '(?<![а-яa-z])(закусих|обядвах|вечерях|похапнах|хапнах|изядох|наядох се|ядох|консумирах|консумирал[аи]?|had breakfast|had lunch|had dinner|had a snack|i ate|ate|i had)(?![а-яa-z])';
const MEAL_RE = new RegExp(MEAL_VERB_SOURCE);
const MEAL_VERB_GLOBAL = new RegExp(MEAL_VERB_SOURCE, 'g');

function mealTypeForVerb(verb) {
  const v = String(verb).toLowerCase();
  if (/закусих|breakfast/.test(v)) return 'breakfast';
  if (/обядвах|lunch/.test(v)) return 'lunch';
  if (/вечерях|dinner/.test(v)) return 'dinner';
  return 'snack';
}

// Trim quotes, surrounding punctuation and stray whitespace so only the food
// description remains (e.g. `„овесени ядки с банан.“` -> `овесени ядки с банан`).
function cleanFood(s) {
  return String(s)
    .replace(/[„“”"'‚‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,!?;:–—-]+/, '')
    .replace(/[\s.,!?;:–—-]+$/, '')
    .trim()
    .slice(0, 200);
}

// Return one { category:'meal', mealType, value } per meal reported in `raw`.
// Matching runs on a lowercased copy (positions line up with the original),
// and each food description is the text between one verb and the next.
function extractMeals(raw) {
  const text = String(raw || '');
  const lower = text.toLowerCase();
  const matches = [...lower.matchAll(MEAL_VERB_GLOBAL)];
  if (!matches.length) return [];

  const meals = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const value = cleanFood(text.slice(start, end));
    if (!value) continue;
    meals.push({
      category: 'meal',
      mealType: mealTypeForVerb(m[1]),
      amount: null,
      unit: null,
      value,
    });
  }
  return meals;
}

// Parse every category from one message. Returns [] when nothing is reported.
function extractHealthEvents(text) {
  const raw = String(text || '').trim();
  const t = normalize(raw);
  if (!t) return [];
  // Questions are handled by isDailyLogQuery; never auto-record from them.
  if (t.endsWith('?')) return [];

  const events = [];
  const water = extractWater(t);
  if (water) events.push({ ...water, raw });
  const sleep = extractSleep(t);
  if (sleep) events.push({ ...sleep, raw });
  const weight = extractWeight(t);
  if (weight) events.push({ ...weight, raw });
  const steps = extractSteps(t);
  if (steps) events.push({ ...steps, raw });
  const workout = extractWorkout(t);
  if (workout) events.push({ ...workout, raw });
  for (const meal of extractMeals(raw)) events.push({ ...meal, raw });
  return events;
}

module.exports = {
  extractHealthEvents,
};
