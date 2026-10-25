// Centralized retrieval layer for the daily health log.
//
// This is the SINGLE place that decides, for a free-text message, whether the
// user is ASKING about a stored health category and, if so, reads the answer
// straight from storage. It replaces the old per-question regex list that had
// to grow by hand for every new phrasing (and silently fell through to the LLM
// whenever a phrasing was missing — the root cause of recurring "it forgot my
// sleep" bugs).
//
// Design:
//   1. ONE category registry (emoji / label / no-data hint / routing keywords).
//   2. Robust routing: normalize the text, require an ASK signal (question word,
//      "?" or the "ли" particle) so plain reports like "спах 7 часа" are never
//      mistaken for questions, then match category keywords + a today/latest
//      scope.
//   3. ONE generic answerer that pulls from storage per category and scope and
//      returns real data — or a clear "no data" message — never a guess.
//
// Adding a new phrasing = add a keyword. Adding a new category = add one
// registry entry + one small formatter. No new branching logic.

const { getToday, getLatest } = require('./dailyLogStorage');

// ── Category registry ───────────────────────────────────────────────────────
// keywords use plain Cyrillic substrings where safe. JS `\b` is ASCII-only, so
// where a word edge matters we use (?<![а-яa-z]) / (?![а-яa-z]) lookarounds.
const CATEGORIES = {
  weight: {
    emoji: '⚖️',
    label: 'Тегло',
    hint: 'Кажи ми напр. „тежа 80 кг" и ще го запиша. 😊',
    keywords: [/тегло/, /тежа/, /теж[аи]/, /килограм/, /(?<![а-яa-z])кг(?![а-яa-z])/, /weight/, /kilo/, /(?<![a-z])kg(?![a-z])/],
  },
  sleep: {
    emoji: '😴',
    label: 'Сън',
    hint: 'Кажи ми напр. „Спах 7 часа и 30 минути" и ще го отбележа. 😊',
    keywords: [/спах/, /спал/, /спя/, /сън/, /slept/, /sleep/],
  },
  steps: {
    emoji: '👟',
    label: 'Стъпки',
    hint: 'Кажи ми напр. „направих 8000 стъпки" и ще ги отбележа. 😊',
    keywords: [/стъпк/, /крачк/, /steps/],
  },
  water: {
    emoji: '💧',
    label: 'Вода',
    hint: 'Кажи ми напр. „изпих 2 чаши вода" и ще го отбележа. 😊',
    keywords: [/вода/, /вод[аеи]/, /хидрат/, /water/, /(?<![а-яa-z])пих(?![а-яa-z])/, /(?<![а-яa-z])пил/],
  },
  meal: {
    emoji: '🍽️',
    label: 'Хранене',
    hint: 'Кажи ми какво хапна и ще го запиша. 😊',
    keywords: [/ядох/, /храни/, /хранен/, /хапн/, /изяд/, /наяд/, /ястия/, /храна/, /меню/, /meal/, /(?<![a-z])ate(?![a-z])/, /(?<![a-z])eat(?![a-z])/, /food/],
  },
  workout: {
    emoji: '🏋️',
    label: 'Тренировка',
    hint: 'Дори кратка разходка се брои! 💪',
    keywords: [/трениров/, /тренира/, /фитнес/, /движени/, /активнос/, /разходк/, /бягах/, /тичах/, /плувах/, /workout/, /exercise/, /(?<![a-z])train/, /(?<![a-z])gym(?![a-z])/, /activity/, /jog/, /(?<![a-z])ran(?![a-z])/, /swam/],
  },
};

// Evaluation order: more specific categories first so overlapping keywords
// (e.g. water's "пих") never steal a clearly weight/sleep/steps question.
const CATEGORY_ORDER = ['weight', 'sleep', 'steps', 'water', 'meal', 'workout'];

const MEAL_TYPE_LABEL = {
  breakfast: 'Закуска',
  lunch: 'Обяд',
  dinner: 'Вечеря',
  snack: 'Междинно хранене',
};

// Emoji/label view used by write-confirmations elsewhere.
const CATEGORY_META = Object.fromEntries(
  Object.entries(CATEGORIES).map(([key, c]) => [key, { emoji: c.emoji, label: c.label }])
);

// ── Routing ─────────────────────────────────────────────────────────────────
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[.,!?;:„“”"'‚‘’()[\]{}<>–—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Words/particles that mark the message as a QUESTION or REQUEST rather than a
// report. Without one of these (or a literal "?") we do not treat the message
// as a retrieval query, so writes stay writes.
// ── Advice vs. data intent ──────────────────────────────────────────────────
// "стъпки"/"вода"/"сън" also appear in HOW-TO requests ("дай ми 3 стъпки как
// да…", "как да пия повече вода") which must go to normal AI conversation,
// not the tracker. A message with an advice/how-to marker is never a
// stored-data query, regardless of which category keywords it contains.
const ADVICE_RE =
  /(?<![а-яa-z])(как(во)?\s+да|да\s+предприем[аеш]*|съвет|посъветв|препоръч|предлож|идеи|идея|начин[иа]?\s+(да|за)|how\s+(to|do i|can i)|tips?|advice|recommend|suggest)(?![а-яa-z])/;
// "стъпки за по-добър сън", "стъпки към целта" — instructional steps, not the
// pedometer, even without an explicit "как да".
// NB: JS \w is ASCII-only — Cyrillic suffixes need an explicit [а-я]* class.
const INSTRUCTIONAL_STEPS_RE = /(стъпк|крачк)[а-я]*\s+(как|за|към)(?![а-яa-z])/;

// Explicit stored-data/report intent OVERRIDES an advice clause in the same
// message: "Как да проверя колко вода изпих днес?" is still a data recall, and
// "Направих 8000 стъпки, как да подобря резултата?" is still a report. Past-
// tense verbs and quantity questions signal data, not how-to.
const DATA_INTENT_RE =
  /(?<![а-яa-z])(колко|какво\s+(ти\s+)?казах|казах\s+ли|записа[хл]?|направих|изпих|изядох|ядох|спах|тежах|изминах|извървях|how\s+(much|many)|did\s+i|have\s+i)(?![а-яa-z])/;

function isAdviceRequest(rawText) {
  const t = normalize(rawText);
  if (DATA_INTENT_RE.test(t)) return false;
  return ADVICE_RE.test(t) || INSTRUCTIONAL_STEPS_RE.test(t);
}

const ASK_RE =
  /(?<![а-яa-z])(колко|какво|каква|какви|какъв|как|кога|кажи|покажи|дай|виж|покажи ми|мои|моя|моят|моето|latest|last|recent|show|what|which|how|tell|list|give|do i|did i|have i)(?![а-яa-z])/;
const QUESTION_PARTICLE_RE = /(?<![а-яa-z])ли(?![а-яa-z])/;
const LATEST_RE = /последн|най.скорош|latest|recent|(?<![a-z])last(?![a-z])/;
const TODAY_RE = /(?<![а-яa-z])днес(?![а-яa-z])|(?<![a-z])today(?![a-z])/;

// Given raw text, return { category, scope } for a stored-data question, else
// null. scope is 'today' or 'latest'.
function matchCategoryQuery(rawText) {
  const raw = String(rawText || '');
  const t = normalize(raw);
  if (!t) return null;

  const asks = /\?/.test(raw) || ASK_RE.test(t) || QUESTION_PARTICLE_RE.test(t);
  if (!asks) return null;

  // Advice/how-to requests are conversations, not data lookups.
  if (isAdviceRequest(raw)) return null;

  // Collect EVERY category the question names — "какво ти казах за водата,
  // стъпките и съня?" must answer all three, not just the first match.
  const categories = CATEGORY_ORDER.filter((key) =>
    CATEGORIES[key].keywords.some((re) => re.test(t))
  );
  if (!categories.length) return null;

  const category = categories[0];
  let scope = LATEST_RE.test(t) ? 'latest' : 'today';
  // Weight isn't a per-day habit; default an unscoped weight question to the
  // most recent entry unless the user explicitly said "today".
  if (categories.length === 1 && category === 'weight' && scope === 'today' && !TODAY_RE.test(t))
    scope = 'latest';

  return { category, categories, scope };
}

// ── Shared read helpers (reused by the coaching summaries too) ──────────────
function round1(n) {
  return Math.round(n * 10) / 10;
}

function byCategory(entries, category) {
  return entries.filter((e) => e.category === category);
}

// Sum water amounts grouped by unit (чаши/л/мл can't be merged safely).
function sumWater(entries) {
  const totals = {};
  for (const e of byCategory(entries, 'water')) {
    if (typeof e.amount === 'number') {
      totals[e.unit] = (totals[e.unit] || 0) + e.amount;
    }
  }
  return Object.entries(totals)
    .map(([unit, amount]) => `${round1(amount)} ${unit}`)
    .join(', ');
}

// ── Formatting ──────────────────────────────────────────────────────────────
function noData(category, scope) {
  const meta = CATEGORIES[category];
  const period = scope === 'today' ? ' за днес' : '';
  return `${meta.emoji} Няма записани данни за „${meta.label}"${period}. ${meta.hint}`;
}

function formatToday(userId, category) {
  const entries = byCategory(getToday(userId), category);
  if (!entries.length) return noData(category, 'today');
  const meta = CATEGORIES[category];

  switch (category) {
    case 'water': {
      const count = entries.length;
      return `💧 *Вода днес:* ${sumWater(entries)} (${count} ${count === 1 ? 'запис' : 'записа'})`;
    }
    case 'meal': {
      const blocks = entries.map((m) => {
        const label = MEAL_TYPE_LABEL[m.mealType] || 'Хранене';
        return `${m.time} — ${label}\n• ${m.value}`;
      });
      return `🍽️ *Хранения днес*\n\n${blocks.join('\n\n')}`;
    }
    case 'workout': {
      const lines = entries.map((w) => `• ${w.time} — ${w.value}`);
      return `🏋️ *Тренировки днес*\n${lines.join('\n')}`;
    }
    case 'steps': {
      const total = entries.reduce((s, e) => s + (e.amount || 0), 0);
      return `👟 *Стъпки днес:* ${total}`;
    }
    case 'sleep':
    case 'weight':
    default: {
      const last = entries[entries.length - 1];
      return `${meta.emoji} *${meta.label} днес:* ${last.value}`;
    }
  }
}

function formatLatest(userId, category) {
  const entry = getLatest(userId, category);
  if (!entry) return noData(category, 'latest');
  const meta = CATEGORIES[category];
  const when = entry.date + (entry.time ? ` ${entry.time}` : '');
  const detail = category === 'meal' && entry.mealType ? `${MEAL_TYPE_LABEL[entry.mealType]}: ${entry.value}` : entry.value;
  return `${meta.emoji} *Последен запис — ${meta.label}:* ${detail} (${when})`;
}

// Route a matched { category(ies), scope } to real stored data. Multi-metric
// questions get ONE coherent reply: every requested category, in registry
// order — available metrics with their values, missing ones with the clear
// "no data" line (never silently dropped).
function answerCategory(userId, { category, categories, scope }) {
  const list = Array.isArray(categories) && categories.length ? categories : [category];
  const parts = list.map((cat) =>
    scope === 'latest' ? formatLatest(userId, cat) : formatToday(userId, cat)
  );
  return parts.join('\n\n');
}

module.exports = {
  CATEGORIES,
  CATEGORY_META,
  MEAL_TYPE_LABEL,
  matchCategoryQuery,
  answerCategory,
  isAdviceRequest,
  // shared read helpers
  byCategory,
  sumWater,
  round1,
};
