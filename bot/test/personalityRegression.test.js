// Offline prompt-contract and authored reference tests, NOT live-model grading.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SYSTEM_PROMPT, GENTLE_GUIDANCE, ROBOTIC_PHRASES } = require('../persona');
const { conversationFlowNote, stripLeadingGreeting } = require('../prompts');

const cases = [
  ['tired', 'Изтощен съм и нямам мотивация.', 'Звучи като ден с малко останали сили. Днес избери почивка вместо тежка тренировка.', /първо разбери състоянието/, /почивка/],
  ['excuse', 'Не съм уморен, просто пак ще пропусна, макар че искам да съм активен.', 'Отлагането няма да помогне на целта ти. Нека днес са само пет минути леко движение.', /Оспорвай избора, не характера/, /пет минути/],
  ['success', 'Днес успях да се разходя за десет минути.', 'Десет минути разходка — това е конкретна стъпка към повече движение. Утре можеш да повториш същото.', /Признавай конкретния напредък/, /Десет минути/],
  ['fact', 'Късното кафе пречи ли на заспиването?', 'Кофеинът може да затрудни заспиването, а чувствителността е различна. Пробвай да преместиш последното кафе по-рано през деня.', /едно-две изречения/, /Кофеинът/],
  ['vulnerable', 'Тъжно ми е, чувствам се провален.', 'Тежко е да се чувстваш така. Един труден ден не определя стойността ти. Какво ти натежа най-много?', /При тъга.*без сарказъм/, /Какво ти натежа/],
  ['joke', 'Диванът ме държи за заложник, хаха.', 'Диванът явно преговаря добре. Пет минути раздвижване и после примирие?', /само при ясно игрив контекст/, /Диванът/],
  ['followup', 'Нека е нещо леко вкъщи.', 'Вкъщи и леко, тогава: пет минути спокойно ходене на място. Без гонене на темпо.', /Продължавай текущата тема при кратко уточнение/, /Вкъщи и леко/],
  ['medical', 'Силно ме боли в гърдите и не мога да дишам.', 'Това изисква спешна помощ — обади се на 112 сега. Не съм лекар и не мога да поставя диагноза.', /НЕ поставяй диагноза и НЕ гадай причина/, /112/],
];
for (const [name, question, reference, rule, expected] of cases) {
  test(`personality contract: ${name}`, () => {
    assert.ok(question);
    assert.match(SYSTEM_PROMPT, rule);
    assert.match(reference, expected);
    assert.ok(reference.length < 240);
    assert.equal(stripLeadingGreeting(reference), reference);
    assert.equal(stripLeadingGreeting(`Здравей! ${reference}`), reference);
    for (const phrase of ROBOTIC_PHRASES)
      assert.ok(!reference.toLowerCase().includes(phrase.toLowerCase()));
    assert.doesNotMatch(reference, /мързелив|засрами|разочарова ме|виновен|аз също тренирах|аз съм човек|чувствам се|моето тяло/i);
  });
}
test('personality safeguards are in the actual shared prompt, not only fixtures', () => {
  assert.match(SYSTEM_PROMPT, /не сляпо съгласен/);
  assert.match(SYSTEM_PROMPT, /Не твърди, че имаш тяло, чувства, лични преживявания/);
  assert.match(SYSTEM_PROMPT, /приеми отказа без настояване/);
  assert.match(SYSTEM_PROMPT, /не измисляй спомени/);
  assert.match(SYSTEM_PROMPT, /често отговаряй без никаква такава фраза/);
  assert.match(GENTLE_GUIDANCE, /болка и заболяване не са оправдания/);
  assert.match(conversationFlowNote('continuing'), /НЕ поздравявай/i);
  const openings = cases.map((c) => c[2].split(' ').slice(0, 2).join(' '));
  assert.equal(new Set(openings).size, cases.length);
});
test('all delivery modes keep shared personality, existing model and response budgets', () => {
  const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.match(index, /let systemContent = SYSTEM_PROMPT/);
  assert.match(index, /model: 'gpt-4o-mini'/);
  assert.match(index, /max_tokens: avatarMode \? 125 : voiceMode \? 300 : freePlan \? 250 : 600/);
  assert.match(SYSTEM_PROMPT, /Text, Voice и Avatar пазят същия характер/);
  assert.equal(require('../prompts').SYSTEM_PROMPT, SYSTEM_PROMPT);
});
