// ─────────────────────────────────────────────────────────────────────────────
// Relationship Memory — the CENTRALIZED layer that lets Eli remember useful,
// long-term personal context (goals, communication preferences, recurring
// struggles, habits, motivation patterns, follow-up topics, meaningful progress
// and clearly-stated emotional context) so she feels like the same caring
// companion over time.
//
// Design principles (from the task spec):
//   • Only durable, useful info is stored — never every message.
//   • A conservative classifier decides save / update / ignore; low confidence
//     is ignored, so casual chatter and transient details are dropped.
//   • Memory is stored verbatim-ish from what the user actually said — Eli never
//     invents a memory.
//   • Health logs stay in their own layer; this file never records water/food/etc.
//   • Memory is per-user isolated (keyed by Telegram id) and fully editable:
//     the user can update, replace or delete anything, and ask what is stored.
//
// This module owns the "what/when to remember" logic and the prompt/summary
// text; the raw persistence lives in relationshipMemoryStorage.js.
// ─────────────────────────────────────────────────────────────────────────────

const store = require('./relationshipMemoryStorage');

// Minimum classifier confidence required to store anything. Below this we treat
// the message as ordinary chatter and ignore it (spec rule 6).
const CONFIDENCE_THRESHOLD = 0.6;

// Human-readable Bulgarian labels for each category, used in the honest summary
// Eli gives when asked "какво помниш за мен".
const CATEGORY_LABELS = {
  goals: '🎯 Цели',
  communication_preferences: '💬 Предпочитания за общуване',
  recurring_challenges: '🌀 Повтарящи се трудности',
  habits: '🔁 Навици, които градиш',
  motivation: '⚡ Мотивация',
  personal_preferences: '❤️ Лични предпочитания',
  follow_up_topics: '📌 Теми за връщане',
  meaningful_progress: '🏆 Значим напредък',
  relationship_context: '🤝 Личен контекст',
  personal_facts: '🧩 Лични факти',
  plans: '🗓 Планове',
  constraints: '🧭 Ограничения',
};

// ── Text helpers ────────────────────────────────────────────────────────────

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[!?.…]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Capitalize the first letter for a tidy stored value.
function tidy(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

// ── Conservative classifier ─────────────────────────────────────────────────
// Returns { action: 'save' | 'update' | 'ignore', category, value, confidence }.
// The rules are high-precision on purpose: they fire only on clear, long-term
// statements and stay silent on everyday chatter.

// Everyday / transient messages we never store, even if a keyword sneaks in.
const IGNORE_PATTERNS = [
  /^(ха)+$/i, // хаха, хахаха
  /^(хе)+$/i,
  /^(добре|ок|окей|ясно|благодаря|мерси|супер|яко|аха|да|не|може|разбрах)[.!]*$/i,
  /^\s*😀|^\s*😂|^\s*👍/,
];

// A message is a "replace/change" (update) when it signals correcting or
// swapping an earlier preference/goal rather than adding a new one.
const UPDATE_CUE = /(вече не|всъщност|отсега|занапред|промених( се)?|размислих|вместо това|поправка)/i;
const SENSITIVE_CUE =
  /(диагноз|болест|заболяв|лекарств|терапи|алерги|интимн|сексуал|религи|политическ|банков|кредитн|дълг|заплат|доход|адресът ми|точния ми адрес|тревожност|депрес|паник|травм|парол|пин код|api[- ]?key|токен|секретен ключ)/iu;
const CREDENTIAL_CUE =
  /(парол(?:а|ата)|пин(?:\s+код)?|api[- ]?key|токен|секретен ключ|код за достъп|номер на картата|cvv|cvc)/iu;
const INTERNAL_INSTRUCTION_CUE =
  /(игнорирай.{0,60}(?:инструкци|систем|правил)|разкр(?:ий|ивай|ийте).{0,60}(?:вътрешн|систем|секрет|инструкц)|покажи.{0,60}(?:системн|вътрешн|скрит prompt)|system prompt|developer message)/iu;
const EXPLICIT_SAVE_CUE =
  /(?:^|[^а-яa-z])(?:искам\s+да\s+(?:запомниш|запишеш|съхраниш|отбележиш)|можеш\s+ли\s+да\s+(?:запомниш|запишеш|съхраниш)|запомни(?:\s+ми)?|запиши(?:\s+ми)?|съхрани|отбележи|добави\s+в\s+(?:паметта|профила)|задръж\s+в\s+паметта)(?![а-яa-z])/iu;
const MEMORY_STOP_WORDS = new Set([
  'аз', 'ами', 'без', 'беше', 'бях', 'вече', 'във', 'вие', 'винаги', 'все',
  'всичко', 'всяка', 'всяко', 'да', 'днес', 'до', 'за', 'знам', 'и', 'или',
  'имам', 'има', 'искам', 'как', 'какво', 'какъв', 'каква', 'като', 'когато',
  'което', 'която', 'които', 'ли', 'ме', 'мен', 'ми', 'много', 'на', 'над',
  'не', 'него', 'нейния', 'нейните', 'нейно', 'ни', 'ние', 'но', 'от', 'по',
  'под', 'при', 'с', 'са', 'сам', 'само', 'се', 'си', 'съм', 'със', 'тези',
  'ти', 'то', 'това', 'този', 'тук', 'той', 'тя', 'хора', 'че', 'ще',
]);

function memoryTokens(value) {
  return String(value || '')
    .toLocaleLowerCase('bg')
    .match(/[а-яa-z0-9]{3,}/giu)
    ?.filter((token) => !MEMORY_STOP_WORDS.has(token) && !/^\d+$/.test(token)) || [];
}

function escapeMemoryJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function isExplicitMemoryCue(text) {
  return EXPLICIT_SAVE_CUE.test(String(text || ''));
}

// Category rules. Each: { category, when: [regexes all-or-any], confidence,
// canonical? } A rule fires when `trigger` matches AND (no `object` OR `object`
// matches). `canonical` maps a match to a normalized stored value (used for
// communication preferences so they dedupe/replace cleanly).
const RULES = [
  // GOALS — an explicit intention to improve/achieve something about health/self.
  {
    category: 'goals',
    trigger: /(искам да|целта ми е|цел(та)? ми е|моята цел|стремя се да|мечтая да|бих искал[а]? да|планирам да|надявам се да)/,
    object: /(подобр|кача|качв|мускул|маса|отслабн|свал(я|я се|ям)|напълн|стана по-|бъда по-|спя по-|съня|сън|хидрат|храня се|хранене|тренир|движа|спра да (пуша|пия)|намаля|увелича|издръжлив|форма|здрав)/,
    confidence: 0.9,
  },
  // HABITS — building a repeated action ("всеки ден", "навик"). Checked before
  // goals-as-habit so a habit statement lands here.
  {
    category: 'habits',
    trigger: /(искам да( си)? изградя|опитвам се да|искам да свикна|уча се да|искам да започна да|мъча се да)/,
    object: /(навик|всеки ден|всяка (сутрин|вечер)|редовно|ежедневно|по-често)/,
    confidence: 0.85,
  },
  // COMMUNICATION PREFERENCES — how the user wants Eli to talk to them.
  {
    category: 'communication_preferences',
    trigger: /(предпочитам|искам|може ли|дай ми|отговаряй|пиши ми|бъди|обичам)/,
    object: /(кратк|по-кратко|сбито|стегнато|накратко)/,
    confidence: 0.9,
    canonical: 'Кратки отговори',
  },
  {
    category: 'communication_preferences',
    trigger: /(предпочитам|искам|може ли|дай ми|отговаряй|пиши ми|обичам)/,
    object: /(подробн|детайлн|по-дълго|обстойн|изчерпателн)/,
    confidence: 0.9,
    canonical: 'Подробни отговори',
  },
  {
    category: 'communication_preferences',
    trigger: /(не обичам|не искам|мразя|стига|без)/,
    object: /(формал|официал)/,
    confidence: 0.85,
    canonical: 'Без формален тон',
  },
  {
    category: 'communication_preferences',
    trigger: /(обръщай (ми )?се|говори ми|пиши ми)/,
    object: /(на ти)/,
    confidence: 0.8,
    canonical: 'Обръщение на „ти“',
  },
  // FOLLOW-UP TOPICS — things the user explicitly wants revisited/reminded.
  {
    category: 'follow_up_topics',
    trigger: /(напомни ми|напомняй ми|искам да поговорим (пак|отново) за|нека пак да (обсъдим|говорим)|върни се към|да не забравя(ме)?)/,
    confidence: 0.8,
  },
  // MEANINGFUL PROGRESS — qualitative milestones (NOT raw metrics — those are
  // health logs). Requires milestone phrasing so plain "свалих 2 кг" is left to
  // the health-log layer.
  {
    category: 'meaningful_progress',
    trigger: /(вече .*(месец|седмица|дни)|цял[аи]? (месец|седмица)|не съм пропус(кал|кала|нал)|издържах|успях да задържа|горд[а]? съм|постигнах (целта|мечтата)|за пръв път успях)/,
    confidence: 0.75,
  },
  // MOTIVATION — what drives the user or when their drive appears.
  {
    category: 'motivation',
    trigger: /(мотивир[а]? ме|зареждам се когато|давам най-доброто когато|най-мотивиран[а]? съм когато|вдъхновява ме)/,
    confidence: 0.75,
  },
  // RECURRING CHALLENGES — chronic struggles. Needs a struggle cue plus a
  // recurring/context cue so one-off gripes are ignored.
  {
    category: 'recurring_challenges',
    trigger: /(трудно( ми е)?|мъчно ми е|боря се|затруднявам се|не успявам|отказвам се|провалям се|изкушавам се|пропускам|нямам воля|губя мотивация)/,
    object: /(след работа|вечер|сутрин|през деня|когато|винаги|често|постоянно|обикновено|все|всеки път|редовно|напоследък)/,
    confidence: 0.8,
  },
  // RELATIONSHIP CONTEXT — clearly-stated, ongoing personal/emotional context.
  // Conservative on purpose (spec rule 4): only ongoing, volunteered situations,
  // never a transient "днес/сега" mood.
  {
    category: 'relationship_context',
    trigger: /(напоследък|от известно време|тези дни постоянно|в момента преживявам|минавам през|преживявам)/,
    object: /(стрес|напрежение|тревог|тъжен|тъга|трудн|тежък период|раздял|развод|загуб|прегаряне|бърнаут)/,
    confidence: 0.7,
  },
  // PERSONAL PREFERENCES — general likes/dislikes stated as lasting facts.
  {
    category: 'personal_preferences',
    trigger: /(обичам да|не обичам да|предпочитам да|мразя да|не понасям)/,
    object: /(тичам|бягам|ходя|разходк|плувам|йога|фитнес|готвя|сутрин|вечер|навън|сам|компания|музика|чета|трени|тренировк|лост|калистен|собствено тегло|спорт|упражнен)/,
    confidence: 0.95,
  },
  // FOOD PREFERENCES — store only an explicit lasting preference, not a meal
  // report. Health events remain in the separate daily-log store.
  {
    category: 'personal_preferences',
    trigger: /(предпочитам|предпочитания(?:та)?(?: ми)? (?:са|включват)|харесвам|обичам|любимите ми храни са|любима храна(?:та)? ми е)/,
    object: /(яйц|овес|пилешк|ориз|лещ|боб|риба|месо|плод|зеленч|млечн|кисело мляко)/,
    confidence: 0.85,
  },
];

function classifyMessage(message) {
  const text = normalize(message);
  const none = { action: 'ignore', category: null, value: null, confidence: 0 };
  if (!text || text.length < 3) return none;
  if (IGNORE_PATTERNS.some((re) => re.test(text))) return none;
  // Sensitive personal information may enter durable memory only through a
  // direct, explicit save command handled by detectMemoryCommand below.
  if (SENSITIVE_CUE.test(text)) return none;

  let best = null;
  for (const rule of RULES) {
    if (!rule.trigger.test(text)) continue;
    if (rule.object && !rule.object.test(text)) continue;
    if (!best || rule.confidence > best.confidence) best = rule;
  }
  if (!best || best.confidence < CONFIDENCE_THRESHOLD) return none;

  const value = best.canonical || tidy(message);
  const action = UPDATE_CUE.test(text) ? 'update' : 'save';
  return { action, category: best.category, value, confidence: best.confidence };
}

// ── Core CRUD (the API required by the spec) ────────────────────────────────

// Which categories hold a single "active" value per dimension, so a new value
// REPLACES the old one instead of piling up (spec rule 14 — update outdated
// preferences). Communication prefs about length are one such dimension.
const LENGTH_PREFS = new Set(['Кратки отговори', 'Подробни отговори']);

function saveRelationshipMemory(userId, category, value) {
  if (!store.isValidCategory(category)) return null;
  const clean = tidy(value);
  if (!clean) return null;

  const existing = store.getUserMemories(userId);
  const norm = normalize(clean);

  // Exact duplicate in the same category → do not store again (dedupe).
  const dup = existing.find(
    (m) => m.category === category && normalize(m.value) === norm
  );
  if (dup) return dup;

  // Conflicting length preference → replace the old one rather than keep both.
  if (LENGTH_PREFS.has(clean)) {
    const conflict = existing.find(
      (m) => m.category === category && LENGTH_PREFS.has(tidy(m.value))
    );
    if (conflict) {
      store.updateMemory(userId, conflict.id, clean);
      return store.getUserMemories(userId).find(
        (m) => m.id === conflict.id && m.category === category && normalize(m.value) === norm
      ) || null;
    }
  }

  const added = store.addMemory(userId, category, clean);
  return store.getUserMemories(userId).find(
    (m) =>
      (added?.id && m.id === added.id) ||
      (m.category === category && normalize(m.value) === norm)
  ) || null;
}

function getRelationshipMemory(userId) {
  return store.getUserMemories(userId);
}

function updateRelationshipMemory(userId, memoryId, value) {
  const clean = tidy(value);
  if (!clean) return null;
  store.updateMemory(userId, memoryId, clean);
  return store.getUserMemories(userId).find(
    (m) => m.id === memoryId && normalize(m.value) === normalize(clean)
  ) || null;
}

function deleteRelationshipMemory(userId, memoryId) {
  const deleted = store.deleteMemory(userId, memoryId);
  if (!deleted) return false;
  return !store.getUserMemories(userId).some((m) => m.id === memoryId);
}

// ── Relevance matching ──────────────────────────────────────────────────────
// Topic keyword sets. A memory is "relevant" to the current message when they
// share at least one topic, so Eli brings memories up only when they fit the
// moment (spec rule 11) instead of reciting them at random.
const TOPICS = {
  sleep: /(сън|съня|спя|спане|лягам|заспив|буден|будя|безсъние|легл|почивк|отспал)/,
  muscle: /(мускул|маса|силов|качване на маса)/,
  weight: /(тегло|килограм|кила|отслабв|отслабн|свал|напълн|качих кила)/,
  nutrition: /(храна|хранене|хапвам|ям|ядене|диета|калори|захар|протеин|въглехидрат)/,
  water: /(вода|хидрат)/,
  workout: /(тренир|фитнес|движение|разходк|ходене|тичам|бягам|спорт|упражн|активност|лост|калистен|собствено тегло|йога|танц|кросфит|пилат)/,
  motivation: /(мотивац|мотивир|отказ|воля|дисциплин|инат|стимул)/,
  stress: /(стрес|напрежение|тревог|притесн|нерв|претовар)/,
  mood: /(настроение|тъжен|тъга|щаст|радост|самочувствие|депрес|самота)/,
  formality: /(формал|официал|кратк|подробн|на ти|тон)/,
};

function topicsOf(text) {
  const t = normalize(text);
  const found = new Set();
  for (const [topic, re] of Object.entries(TOPICS)) {
    if (re.test(t)) found.add(topic);
  }
  return found;
}

function findRelevantRelationshipMemory(userId, currentMessage) {
  const memories = store.getUserMemories(userId);
  if (!memories.length) return [];
  const msgTopics = topicsOf(currentMessage);
  if (!msgTopics.size) return [];
  const scored = memories
    .map((m) => {
      const overlap = [...topicsOf(m.value)].filter((t) => msgTopics.has(t));
      return { m, score: overlap.length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.map((x) => x.m);
}

// ── Passive capture from an ordinary message ────────────────────────────────
// Runs the classifier and persists only when it is confident. Returns
// { action, entry } so callers/tests can see what happened.
function rememberFromMessage(userId, message) {
  const result = classifyMessage(message);
  if (result.action === 'ignore') return { action: 'ignore', entry: null };
  const entry = saveRelationshipMemory(userId, result.category, result.value);
  return entry
    ? { action: result.action, entry }
    : { action: 'error', entry: null };
}

function saveExplicitRelationshipMemory(userId, message) {
  if (!isExplicitMemoryCue(message)) return { ok: false, reason: 'not_explicit' };
  const result = classifyMessage(message);
  if (result.action === 'ignore') return { ok: false, reason: 'unsupported' };

  try {
    const entry = saveRelationshipMemory(userId, result.category, result.value);
    const persisted = getRelationshipMemory(userId).find(
      (m) =>
        m.category === result.category &&
        normalize(m.value) === normalize(result.value)
    );
    if (!entry || !persisted) return { ok: false, reason: 'verification_failed' };
    return { ok: true, category: persisted.category, value: persisted.value };
  } catch {
    return { ok: false, reason: 'storage_failed' };
  }
}

// ── Prompt context ──────────────────────────────────────────────────────────
// Builds the block injected into the system prompt. Includes communication
// preferences ALWAYS (they shape every reply) plus memories relevant to the
// current message. Empty string when there is nothing worth injecting, so Eli
// never pretends to remember something that isn't stored (spec rule 13).
function buildRelationshipContext(userId, currentMessage) {
  const memories = store.getUserMemories(userId);
  if (!memories.length) return '';

  const commPrefs = memories.filter(
    (m) => m.category === 'communication_preferences'
  );
  const relevant = findRelevantRelationshipMemory(userId, currentMessage).filter(
    (m) => m.category !== 'communication_preferences'
  );

  if (!commPrefs.length && !relevant.length) return '';

  const lines = [
    'ОТНОШЕНСКА ПАМЕТ (какво си запомнила за този човек от предишни разговори). Използвай я само ако е уместно СЕГА. Вплитай я естествено, като приятел, който помни — НИКОГА не я изброявай като база данни и никога не казвай „според запаметената информация“. Никога не твърди, че помниш нещо, което не е в този списък.',
  ];

  for (const m of relevant) {
    const label = CATEGORY_LABELS[m.category] || m.category;
    lines.push(`- ${label}: ${m.value}`);
  }

  // Communication preferences become direct behavioral instructions so Eli
  // honors them by default without asking every time.
  const directives = [];
  for (const p of commPrefs) {
    const v = tidy(p.value);
    if (v === 'Кратки отговори') directives.push('Отговаряй кратко по подразбиране, без да питаш всеки път.');
    else if (v === 'Подробни отговори') directives.push('Този човек харесва по-подробни, обстойни отговори.');
    else if (v === 'Без формален тон') directives.push('Дръж тона неформален и топъл, никога официален.');
    else directives.push(v);
  }
  if (directives.length) {
    lines.push('Как предпочита да общувате:');
    for (const d of directives) lines.push(`- ${d}`);
  }

  return lines.join('\n');
}

// ── Honest, human-readable summary ("what do you remember about me") ─────────
function formatRelationshipMemory(userId, opts = {}) {
  const memories = store.getUserMemories(userId);
  if (!memories.length) {
    if (opts.section) return '';
    return 'Още не съм запомнила нищо специално за теб от разговорите ни. 😊 Разкажи ми за целите си или как предпочиташ да си говорим — и започвам да помня.';
  }

  const byCategory = {};
  for (const m of memories) {
    (byCategory[m.category] ||= []).push(m);
  }

  const lines = [opts.section ? '🤝 *Какво помня за теб от разговорите ни*' : '🤝 *Ето какво помня за теб*'];
  for (const category of store.CATEGORIES) {
    const items = byCategory[category];
    if (!items || !items.length) continue;
    lines.push('', `*${CATEGORY_LABELS[category] || category}*`);
    for (const m of items) lines.push(`• ${m.value}`);
  }
  return lines.join('\n');
}

// ── Explicit memory commands (recall / forget / update) ─────────────────────
// Detects when the user is directly managing their memory, e.g.
//   "Какви цели съм ти казвал?"                 → recall (goals)
//   "Забрави, че предпочитам кратки отговори."   → forget
//   "Промени целта ми на покачване на маса."     → update
// Returns null for ordinary messages.
function detectMemoryCommand(message) {
  const text = normalize(message);
  if (!text) return null;

  // FORGET — starts with a delete verb. The negative lookahead for a Cyrillic
  // letter keeps "забрави" (forget it) from matching "забравих" (I forgot).
  // NB: \b is unreliable around Cyrillic in ASCII regex mode, so we avoid it.
  const forget = text.match(
    /^(забрави|изтрий|махни|премахни|не помни(?: повече)?)(?![а-я])(.*)$/
  );
  if (forget) {
    const rest = forget[2].replace(/^\s*(,|че|за)\s*/i, '').trim();
    if (/^(всичко|паметта|всичко за мен)$/.test(rest) || rest === '') {
      return { type: 'forget', target: rest, all: /всичко|паметта/.test(rest) };
    }
    return { type: 'forget', target: rest, all: false };
  }

  // UPDATE — "промени/смени X на Y".
  const update = text.match(
    /(?:промени|смени|обнови|актуализирай|редактирай)\s+(.+?)\s+на\s+(.+)/
  );
  if (update) {
    const target = update[1].trim();
    return {
      type: 'update',
      target,
      value: tidy(update[2]),
      category: targetToCategory(target),
      topic: targetToTopic(target),
    };
  }

  // Direct recall for preference questions. Keep this deterministic so the
  // answer comes from the user's own stored facts, not a model guess.
  if (
    /как(?:ъв|ва|ви)\s+(?:вид\s+)?(?:трениров|спорт|упражнен).*(?:предпочит|харесв|обич)/.test(text) ||
    /какво\s+предпочитам\s+да\s+тренирам/.test(text)
  ) {
    return {
      type: 'recall',
      category: 'personal_preferences',
      topic: 'workout',
    };
  }

  // RECALL — category-specific ("какви цели съм ти казвал"). No \b — see note
  // above about Cyrillic word boundaries.
  if (/какв(и|о)\s+(цел|цели)\s+.*(казвал|казах|споделял|са ми|имам|съм ти)/.test(text)) {
    return { type: 'recall', category: 'goals' };
  }
  return null;
}

function targetToCategory(target) {
  const t = normalize(target);
  if (/цел/.test(t)) return 'goals';
  if (/навик/.test(t)) return 'habits';
  if (/трениров|спорт|упражнен|лост|калистен|йога|фитнес/.test(t)) {
    return 'personal_preferences';
  }
  if (/кратк|подробн|формал|официал|отговор|тон|обръщ/.test(t)) {
    return 'communication_preferences';
  }
  if (/предпочитан/.test(t)) return 'personal_preferences';
  if (/мотивац/.test(t)) return 'motivation';
  return null;
}

function targetToTopic(target) {
  const found = topicsOf(target);
  return found.size === 1 ? [...found][0] : null;
}

function findMemoryCommandMatches(memories, target, category, explicitTopic = null) {
  let candidates = memories.filter((m) => !category || m.category === category);
  const topic = explicitTopic || targetToTopic(target);
  if (topic) candidates = candidates.filter((m) => topicsOf(m.value).has(topic));
  if (!candidates.length) return [];

  const tokens = memoryTokens(target);
  if (!tokens.length) return candidates.length === 1 ? candidates : [];
  const scored = candidates
    .map((memory) => {
      const valueTokens = new Set(memoryTokens(memory.value));
      const tokenScore = tokens.reduce(
        (score, token) => score + Number(valueTokens.has(token)),
        0
      );
      const topicScore = topic && topicsOf(memory.value).has(topic) ? 1 : 0;
      return { memory, score: tokenScore + topicScore };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return candidates.length === 1 ? candidates : [];
  const best = scored[0].score;
  return scored.filter((item) => item.score === best).map((item) => item.memory);
}

// Executes a detected command and returns a warm Bulgarian reply (Markdown).
function applyMemoryCommand(userId, cmd) {
  if (!cmd) return null;

  if (cmd.type === 'recall') {
    try {
      const allMemories = getRelationshipMemory(userId);
      const memories = allMemories.filter(
        (m) =>
          (!cmd.category || m.category === cmd.category) &&
          (!cmd.topic || topicsOf(m.value).has(cmd.topic))
      );
      if (!memories.length) {
        if (cmd.category === 'goals') {
          return 'Още не си ми казвал конкретна цел. Каква искаш да си поставим? 😊';
        }
        if (cmd.topic === 'workout') {
          return 'Не открих запазено предпочитание за тренировки. Ако искаш, кажи ми какво предпочиташ и изрично ме помоли да го запомня. 😊';
        }
        return formatRelationshipMemory(userId);
      }
      const label = CATEGORY_LABELS[cmd.category] || 'Ето какво помня';
      const list = memories.map((m) => `• ${m.value}`).join('\n');
      return `${label}, които си споделял с мен:\n${list}`;
    } catch {
      return 'Не успях да проверя паметта ти, затова няма да гадая. Опитай отново след малко.';
    }
  }

  if (cmd.type === 'forget') {
    try {
      const before = getRelationshipMemory(userId);
      if (cmd.all) {
        if (!before.length) {
          return 'Нямаше какво да изтрия — още не съм запомнила нищо за теб. 😊';
        }
        store.deleteAllForUser(userId);
        if (getRelationshipMemory(userId).length) {
          return 'Не успях да потвърдя изтриването, затова няма да твърдя, че паметта е изчистена. Опитай отново.';
        }
        return 'Готово — изчистих всичко, което помнех за теб. Започваме на чисто. 💚';
      }

      const toDelete = findMemoryCommandMatches(
        before,
        cmd.target,
        cmd.category || null,
        cmd.topic || null
      );
      if (!toDelete.length) {
        return 'Не открих еднозначно такава памет, така че не изтрих нищо. Можеш да уточниш конкретния факт. 😊';
      }
      if (toDelete.length > 1) {
        return 'Намерих няколко сходни записа и не искам да изтрия грешния. Уточни кой точно да забравя.';
      }
      const deleted = deleteRelationshipMemory(userId, toDelete[0].id);
      if (!deleted || getRelationshipMemory(userId).some((m) => m.id === toDelete[0].id)) {
        return 'Не успях да потвърдя изтриването, затова няма да твърдя, че съм го забравила. Опитай отново.';
      }
      return `Забравено. Вече няма да помня „${toDelete[0].value}“. 💚`;
    } catch {
      return 'Не успях да проверя или променя паметта ти, затова няма да твърдя, че е изтрита. Опитай отново.';
    }
  }

  if (cmd.type === 'update') {
    const category = cmd.category;
    if (!category) {
      return 'Кажи ми точно какво да променя — например „промени целта ми на …“. 😊';
    }
    try {
      const memories = getRelationshipMemory(userId);
      const matches = findMemoryCommandMatches(
        memories,
        cmd.target,
        category,
        cmd.topic || null
      );
      if (!matches.length) {
        return 'Не открих еднозначно записа, който искаш да променя. Не създадох нова памет; уточни кой факт имаш предвид.';
      }
      if (matches.length > 1) {
        return 'Намерих няколко сходни записа и не искам да променя грешния. Уточни кой точно имаш предвид.';
      }

      let value = cmd.value;
      if (cmd.topic === 'workout' && !/^предпочитан вид тренировка:/i.test(value)) {
        value = `Предпочитан вид тренировка: ${value}`;
      }
      const updated = updateRelationshipMemory(userId, matches[0].id, value);
      const verified = getRelationshipMemory(userId).some(
        (m) => m.id === matches[0].id && normalize(m.value) === normalize(value)
      );
      if (!updated || !verified) {
        return 'Не успях да потвърдя промяната в паметта ти, затова няма да твърдя, че е направена. Опитай отново.';
      }
      return `Готово — актуализирах записа и проверих, че е запазен като „${value}“. 💚`;
    } catch {
      return 'Не успях да проверя или променя паметта ти, затова няма да твърдя, че е актуализирана. Опитай отново.';
    }
  }

  return null;
}

module.exports = {
  // required API
  saveRelationshipMemory,
  getRelationshipMemory,
  updateRelationshipMemory,
  deleteRelationshipMemory,
  findRelevantRelationshipMemory,
  classifyMessage,
  // integration helpers
  rememberFromMessage,
  saveExplicitRelationshipMemory,
  buildRelationshipContext,
  formatRelationshipMemory,
  detectMemoryCommand,
  applyMemoryCommand,
  isExplicitMemoryCue,
  // constants (handy for tests / reuse)
  CATEGORY_LABELS,
  CONFIDENCE_THRESHOLD,
};
