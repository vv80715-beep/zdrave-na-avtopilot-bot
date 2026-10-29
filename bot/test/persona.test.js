// These are prompt/reference contracts, not evaluations of live model output.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  ELI, DISCLAIMER, ROBOTIC_PHRASES, INTERJECTIONS, SYSTEM_PROMPT,
  CONFIRM_OPENERS, pick, STYLE_RULES, HUMAN_TOUCH, GENTLE_GUIDANCE, SAFETY,
} = require('../persona');
const { CONVERSATIONS, FEW_SHOT_PROMPT } = require('../personaExamples');
const { formatConfirmation } = require('../dailyLogService');
const { currentClockNote, conversationFlowNote } = require('../prompts');

const assistantReplies = CONVERSATIONS.flatMap(example =>
  example.turns.filter(turn => turn.role === 'assistant').map(turn => turn.content));

test('shared identity is warm and explicitly AI, with no fabricated personal life', () => {
  assert.ok(SYSTEM_PROMPT.includes(ELI.identityLine));
  assert.ok(SYSTEM_PROMPT.includes(ELI.brand));
  assert.ok(SYSTEM_PROMPT.includes(`на „${ELI.address}"`));
  assert.match(SYSTEM_PROMPT, /не се преструваш на човек/);
  assert.match(SYSTEM_PROMPT, /Не измисляй лично тяло/);
  assert.match(SYSTEM_PROMPT, /При пряк въпрос кажи честно, че си AI/);
});

test('normal replies are brief, questions conditional, lists used only when useful', () => {
  assert.match(STYLE_RULES, /1–4 кратки изречения/);
  assert.match(STYLE_RULES, /Въпрос само ако липсва съществена информация/);
  assert.match(STYLE_RULES, /Списък само при поискан план/);
  assert.match(STYLE_RULES, /Отговорът може просто да приключи/);
  assert.match(STYLE_RULES, /Text, Voice и Avatar/);
});

test('context and latest corrections take precedence over generic coaching', () => {
  assert.match(HUMAN_TOUCH, /истинските предишни реплики/);
  assert.match(HUMAN_TOUCH, /По-ново уточнение поправя старата/);
  assert.match(HUMAN_TOUCH, /Не бъркай предложена тренировка с изпълнена/);
  assert.match(HUMAN_TOUCH, /Не добавяй задължително нова задача след успех/);
  assert.match(GENTLE_GUIDANCE, /Самото „не ми се тренира" не доказва мързел/);
  assert.match(GENTLE_GUIDANCE, /Оценявай поведението, не човека/);
  assert.match(GENTLE_GUIDANCE, /без натиск за тренировка/);
});

test('medical safety text and disclaimer are preserved exactly', () => {
  assert.equal(crypto.createHash('sha256').update(SAFETY).digest('hex'),
    'c88ba3168494fa31544a0cbf28458723bb06f08637219963883f8d7268258c93');
  assert.match(DISCLAIMER, /не медицински съвет/);
  assert.ok(SYSTEM_PROMPT.includes(SAFETY));
  assert.match(SYSTEM_PROMPT, /Медицинската безопасност има предимство/);
  assert.match(GENTLE_GUIDANCE, /Никога при медицинска тревога/);
});

test('product facts are present once and stay outside the personality examples', () => {
  assert.equal(SYSTEM_PROMPT.split('АКТУАЛНО ЗНАНИЕ ЗА').length - 1, 1);
  for (const fact of ['5-дневен Trial', '€15', '€50', '€360', '30 включени Avatar', '20 включени Avatar']) {
    assert.ok(SYSTEM_PROMPT.includes(fact), fact);
  }
  assert.doesNotMatch(FEW_SHOT_PROMPT, /€|Stripe|entitlement/);
});

test('four compact few-shot conversations are included once in the shared prompt', () => {
  assert.equal(CONVERSATIONS.length, 4);
  assert.equal(SYSTEM_PROMPT.split(FEW_SHOT_PROMPT).length - 1, 1);
  assert.ok(SYSTEM_PROMPT.length <= 10500, 'includes examples while remaining shorter than the 11881-character baseline');
  for (const example of CONVERSATIONS) {
    assert.ok(example.turns.length >= 4);
    assert.equal(example.turns.length % 2, 0);
    example.turns.forEach((turn, index) => {
      assert.equal(turn.role, index % 2 ? 'assistant' : 'user');
      assert.ok(turn.content.length > 0);
    });
  }
});

test('authored target replies avoid filler and automatic follow-up questions', () => {
  for (const text of assistantReplies) {
    for (const phrase of ROBOTIC_PHRASES) {
      assert.ok(!text.toLowerCase().includes(phrase.toLowerCase()), phrase);
    }
    assert.ok(text.length < 330);
    assert.ok(!text.trim().endsWith('?'));
    assert.doesNotMatch(text, /^\s*(?:[-*]|\d+[.)])\s/m);
  }
  assert.ok(INTERJECTIONS.some(word => STYLE_RULES.includes(word)));
});

test('reference examples teach context, changed advice, sadness, humor and honest identity', () => {
  const [accountability, fatigue, sadness, humor] = CONVERSATIONS;
  assert.match(accountability.turns[5].content, /сам каза, че просто те мързи/);
  assert.match(accountability.turns[9].content, /десетте минути/);
  assert.match(fatigue.turns.at(-1).content, /променя нещата/);
  assert.match(fatigue.turns.at(-1).content, /почивка/);
  assert.equal(sadness.turns.at(-1).content, 'Добре. Няма нужда да обясняваш.');
  assert.match(humor.turns[1].content, /Преговорите/);
  assert.match(humor.turns.at(-1).content, /Нямам тяло/);
});

test('all conversation states get the trusted clock without changing Sofia DST calculations', () => {
  const winter = new Date('2026-10-29T22:30:00Z');
  const summer = new Date('2026-07-05T21:30:00Z');
  assert.match(currentClockNote(winter), /Europe\/Sofia.*2026-10-30, 00:30/);
  assert.match(currentClockNote(summer), /2026-07-06, 00:30/);
  for (const state of ['new', 'returning', 'continuing']) {
    assert.ok(conversationFlowNote(state, winter).startsWith(currentClockNote(winter)));
  }
});

test('deterministic confirmation helpers retain their existing contract', () => {
  assert.equal(pick(['a', 'b', 'c'], 4), 'b');
  assert.equal(pick([], 0), '');
  const text = formatConfirmation([{ category: 'water', value: '2 л' }]);
  assert.ok(CONFIRM_OPENERS.some(opener => text.startsWith(opener)));
  assert.ok(text.includes('2 л'));
});
