const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ELI,
  DISCLAIMER,
  ROBOTIC_PHRASES,
  INTERJECTIONS,
  SYSTEM_PROMPT,
  CONFIRM_OPENERS,
  pick,
} = require('../persona');
const { EXAMPLES } = require('../personaExamples');
const { formatConfirmation } = require('../dailyLogService');

// Build a case-insensitive matcher for each forbidden robotic phrase.
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const ROBOTIC_RES = ROBOTIC_PHRASES.map((p) => new RegExp(escapeRe(p), 'i'));

function hasRobotic(text) {
  return ROBOTIC_RES.some((re) => re.test(text));
}

// ── Centralized persona is the single source of truth ───────────────────────

test('SYSTEM_PROMPT states Eli\'s identity and brand', () => {
  assert.ok(SYSTEM_PROMPT.includes(ELI.name), 'names Eli');
  assert.ok(SYSTEM_PROMPT.includes(ELI.brand), 'names the brand');
  assert.ok(SYSTEM_PROMPT.includes(ELI.identityLine), 'includes the identity line');
});

test('SYSTEM_PROMPT forbids the robotic phrases (they appear only in the avoid list)', () => {
  // Every forbidden phrase should be present in the prompt as something to
  // AVOID, and the rule section must be explicit about it.
  assert.ok(/НЕ използвай/i.test(SYSTEM_PROMPT), 'has an explicit "do not use" rule');
  assert.ok(/роботск/i.test(SYSTEM_PROMPT), 'calls the phrases robotic');
  for (const phrase of ROBOTIC_PHRASES) {
    assert.ok(SYSTEM_PROMPT.includes(phrase), `avoid-list mentions: ${phrase}`);
  }
});

test('SYSTEM_PROMPT encodes the key style rules', () => {
  assert.ok(/разграничавай/i.test(SYSTEM_PROMPT), 'wellness vs medical distinction');
  assert.ok(/емпати/i.test(SYSTEM_PROMPT), 'empathy-first');
  assert.ok(/112/.test(SYSTEM_PROMPT), 'emergency guidance');
  assert.ok(new RegExp(`на „${ELI.address}"`).test(SYSTEM_PROMPT), 'informal address');
});

test('SYSTEM_PROMPT encodes the human-personality behaviors', () => {
  // Sounds like a real person, varies openings, celebrates, stays warm.
  assert.ok(/като истински човек/i.test(SYSTEM_PROMPT), 'act like a real person');
  assert.ok(/не започвай два/i.test(SYSTEM_PROMPT), 'never repeat the same opening');
  assert.ok(/последващи въпроси/i.test(SYSTEM_PROMPT), 'asks natural follow-up questions');
  assert.ok(/напредъка/i.test(SYSTEM_PROMPT), 'celebrates progress');
  assert.ok(/не манипулира/i.test(SYSTEM_PROMPT), 'emotionally intelligent, never manipulative');
  // Gentle, non-forced steering back toward habits.
  assert.ok(/меко и естествено/i.test(SYSTEM_PROMPT), 'gentle, natural guidance');
  assert.ok(/никога насила/i.test(SYSTEM_PROMPT), 'never forces the topic');
  // Never feels like a sales pitch.
  assert.ok(/не.{0,3}продавач|не звучиш като продажба/i.test(SYSTEM_PROMPT), 'never sells');
  // The interjection vocabulary is wired into the prompt.
  assert.ok(INTERJECTIONS.every((w) => SYSTEM_PROMPT.includes(w)), 'lists the human interjections');
});

// ── Deterministic voice helpers shared across routes ────────────────────────

test('pick is deterministic for a numeric seed and stays in range', () => {
  const list = ['a', 'b', 'c'];
  assert.equal(pick(list, 0), 'a');
  assert.equal(pick(list, 1), 'b');
  assert.equal(pick(list, 4), 'b'); // 4 % 3 === 1
  assert.equal(pick([], 0), '');
});

test('log confirmation uses a persona opener (shared voice across routes)', () => {
  const out = formatConfirmation([{ category: 'water', value: '2 л' }]);
  assert.ok(
    CONFIRM_OPENERS.some((opener) => out.startsWith(opener)),
    'confirmation starts with a centralized opener'
  );
  assert.ok(out.includes('2 л'), 'still reports the logged value');
});

test('DISCLAIMER is exported and reads as wellness-not-medical', () => {
  assert.ok(/не медицински съвет/i.test(DISCLAIMER));
});

// ── Golden examples: new Eli style obeys the rules; old style did not ────────

test('every example targets all eight required questions', () => {
  const ids = EXAMPLES.map((e) => e.id);
  for (const id of [
    'capabilities', 'help', 'limits', 'no_training',
    'low_sleep', 'water_logged', 'brand', 'chest_pain',
  ]) {
    assert.ok(ids.includes(id), `missing example: ${id}`);
  }
});

test('no newStyle example contains a robotic phrase', () => {
  for (const ex of EXAMPLES) {
    assert.ok(!hasRobotic(ex.newStyle), `newStyle for "${ex.id}" is robotic: ${ex.newStyle}`);
  }
});

test('the old generic style demonstrates the robotic phrasing we removed', () => {
  // Contrast must be real: several oldStyle answers should trip the matcher.
  const robotic = EXAMPLES.filter((ex) => hasRobotic(ex.oldStyle)).map((e) => e.id);
  for (const id of ['capabilities', 'help', 'limits']) {
    assert.ok(robotic.includes(id), `oldStyle for "${id}" should look robotic`);
  }
});

test('newStyle stays informal (no formal "Вие" address)', () => {
  const FORMAL = /(?<![а-я])(можете|имате|вашия|вашата|вашето|бихте)(?![а-я])/i;
  for (const ex of EXAMPLES) {
    assert.ok(!FORMAL.test(ex.newStyle), `newStyle for "${ex.id}" uses formal address`);
  }
});

test('simple-question answers stay concise', () => {
  for (const id of ['capabilities', 'help', 'limits', 'brand']) {
    const ex = EXAMPLES.find((e) => e.id === id);
    assert.ok(ex.newStyle.length <= 320, `newStyle for "${id}" is too long (${ex.newStyle.length})`);
  }
});

test('empathy-first examples lead with acknowledgement, not advice', () => {
  const noTraining = EXAMPLES.find((e) => e.id === 'no_training');
  assert.ok(/няма проблем|и такива дни|не се насилвай/i.test(noTraining.newStyle));
  const lowSleep = EXAMPLES.find((e) => e.id === 'low_sleep');
  assert.ok(/малко|уморен|бъди мек/i.test(lowSleep.newStyle));
});

test('chest-pain answer is a safe redirect, never a diagnosis', () => {
  const ex = EXAMPLES.find((e) => e.id === 'chest_pain');
  assert.ok(/спешно|лекар/i.test(ex.newStyle), 'redirects to a doctor / urgent care');
  assert.ok(/112/.test(ex.newStyle), 'mentions emergency number');
  assert.ok(/не съм лекар/i.test(ex.newStyle), 'states it is not a doctor');
  // Must NOT speculate about causes (the old style did).
  assert.ok(!/може да се дължи|вероятно се дължи|най-вероятно е/i.test(ex.newStyle), 'no cause speculation');
});

test('progress acknowledgement gives a next step', () => {
  const water = EXAMPLES.find((e) => e.id === 'water_logged');
  assert.ok(/чудесно|супер|браво/i.test(water.newStyle), 'acknowledges progress');
  assert.ok(/продължавай|утре/i.test(water.newStyle), 'offers a next step');
});

// ── Human personality: 15+ before/after conversations ───────────────────────

test('there are at least 15 before/after conversation examples', () => {
  assert.ok(EXAMPLES.length >= 15, `only ${EXAMPLES.length} examples`);
});

test('every example has a distinct opening (Eli never repeats the same opener)', () => {
  const openers = EXAMPLES.map((e) =>
    e.newStyle.split(/[\s.,!?…]+/).slice(0, 2).join(' ').toLowerCase()
  );
  assert.equal(new Set(openers).size, openers.length, 'two examples share an opening');
});

test('interjections are used sparingly, not in every reply', () => {
  const withInterjection = EXAMPLES.filter((e) =>
    INTERJECTIONS.some((w) => e.newStyle.includes(w.replace('…', '')))
  );
  assert.ok(withInterjection.length >= 1, 'at least one example uses an interjection');
  assert.ok(
    withInterjection.length <= Math.ceil(EXAMPLES.length / 2),
    'interjections should not appear in most replies'
  );
});

test('Eli asks natural follow-up questions to keep the conversation going', () => {
  const withQuestion = EXAMPLES.filter((e) => e.newStyle.trim().endsWith('?'));
  assert.ok(withQuestion.length >= 5, `only ${withQuestion.length} examples ask a follow-up`);
});

test('no example sounds like a sales pitch', () => {
  const SALES = /(купи|поръчай|абонамент|абонирай|цена|промоц|оферт|отстъпк|плати)/i;
  for (const ex of EXAMPLES) {
    assert.ok(!SALES.test(ex.newStyle), `newStyle for "${ex.id}" sounds sales-y`);
  }
});

test('gentle guidance: "tired" leads with empathy then softly asks about a habit', () => {
  const tired = EXAMPLES.find((e) => e.id === 'tired');
  assert.ok(/тежък ден|уморен|звучи/i.test(tired.newStyle), 'acknowledges the feeling first');
  assert.ok(/вода|хапн|храна|яде/i.test(tired.newStyle), 'softly steers toward a habit');
  assert.ok(tired.newStyle.trim().endsWith('?'), 'asks rather than instructs');
  assert.ok(!/спи \d|трябва да спиш/i.test(tired.newStyle), 'does not force a sleep prescription');
});

test('companion mode: sadness is met with listening, not a health checklist', () => {
  const down = EXAMPLES.find((e) => e.id === 'feeling_down');
  assert.ok(/съжалявам|тежко/i.test(down.newStyle), 'empathizes');
  assert.ok(down.newStyle.trim().endsWith('?'), 'invites the person to share');
  assert.ok(!/съвет|препоръчвам|физическа активност/i.test(down.newStyle), 'no advice dump');
});

test('celebration: real wins get genuine, specific praise', () => {
  const weight = EXAMPLES.find((e) => e.id === 'weight_progress');
  assert.ok(/супер|честно|браво|🎉/i.test(weight.newStyle), 'celebrates warmly');
  assert.ok(!/калориен дефицит|калории/i.test(weight.newStyle), 'no clinical lecture');
});

test('"are you real" and "how are you" stay warm and human, not robotic', () => {
  for (const id of ['are_you_real', 'how_are_you']) {
    const ex = EXAMPLES.find((e) => e.id === id);
    assert.ok(!hasRobotic(ex.newStyle), `"${id}" is robotic`);
    assert.ok(!/изкуствен интелект, създаден|нямам чувства/i.test(ex.newStyle), `"${id}" is cold`);
  }
});
