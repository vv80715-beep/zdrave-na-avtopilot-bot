// Authored conversation targets and real context plumbing, not live AI grading.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SYSTEM_PROMPT, HUMAN_TOUCH, GENTLE_GUIDANCE } = require('../persona');
const { stripLeadingGreeting } = require('../prompts');
const { ownerRememberTurn, ownerRecentTurns, clearOwnerTurns } = require('../ownerSession');
const { createOpenAIClientWrapper } = require('../textAIClient');

const exchanges = [
  ['Днес не ми се тренира.', 'Умора ли е, или по-скоро не ти се започва?'],
  ['Просто ме мързи.', 'Тогава май отлагаш, а не ти липсват сили. Айде само пет минути и после решаваш.'],
  ['Добре де, какво да направя само за 10 минути?', 'Направи десет минути спокойно ходене на място вкъщи: две бавно за начало, шест в удобно темпо и две бавно за край.'],
  ['Ей, направих го.', 'Ето така — десетте минути вкъщи са готови, въпреки че не ти се започваше. Днес не остави отлагането да решава вместо теб.'],
  ['Кажи ми честно — търся ли си оправдания?', 'Да, в началото малко си търсеше оправдание — сам каза, че те мързи. Но после направи десетте минути, така че не се остави на това.'],
  ['Утре пак същото ли?', 'Можеш да повториш същите десет минути ходене вкъщи, ако се чувстваш добре. Няма нужда веднага да увеличаваш.'],
];
for (const [question, target] of exchanges) {
  test(`conversation reference: ${question}`, () => {
    assert.equal(stripLeadingGreeting(`Здравей! ${target}`), target);
    assert.equal(stripLeadingGreeting(target), target);
    assert.ok(target.length < 260);
    assert.doesNotMatch(target, /^(Разбирам те|Всеки има|В днешно време|Важно е балансът|Радвам се, че сподели)/i);
    assert.doesNotMatch(target, /аз съм човек|аз тренирах|моето тяло|и аз спах|засрами|мързеливец|разочарова ме/i);
    assert.doesNotMatch(target, /^\s*(?:\d+[.)]|[-*#])\s/m);
  });
}
test('conversation shape does not require questions or repeating catchphrases', () => {
  assert.ok(exchanges.filter(([, reply]) => reply.endsWith('?')).length <= 2);
  assert.equal(new Set(exchanges.map(([, reply]) => reply.split(' ').slice(0, 2).join(' '))).size, exchanges.length);
  assert.match(HUMAN_TOUCH, /само когато липсва важна информация/);
  assert.match(HUMAN_TOUCH, /един конкретен миниплан/);
  assert.match(GENTLE_GUIDANCE, /пряка, тактична преценка/);
  assert.match(GENTLE_GUIDANCE, /отчитай какво се е променило/);
  assert.match(SYSTEM_PROMPT, /Обикновено 1–4 кратки изречения/);
});
test('emotional calibration and identity safeguards remain in shared prompt', () => {
  assert.match(HUMAN_TOUCH, /при раздразнение — спокойно и директно/);
  assert.match(HUMAN_TOUCH, /при тъга и тревожност — по-меко и кратко/);
  assert.match(HUMAN_TOUCH, /Без хумор при спешни симптоми, самонараняване, скръб/);
  assert.match(SYSTEM_PROMPT, /само при ясно игрив контекст/);
  assert.match(SYSTEM_PROMPT, /Не твърди, че имаш тяло, чувства, лични преживявания/);
  assert.match(SYSTEM_PROMPT, /112/);
});
test('real recent-turn buffer carries avoidance and accomplishment to one mocked AI call per turn', async () => {
  const id = 'offline-persona-sequence';
  clearOwnerTurns(id);
  let calls = 0;
  const client = createOpenAIClientWrapper({ chat: { completions: {
    create: async ({ model, messages, max_tokens }) => {
      assert.equal(model, 'gpt-4o-mini');
      assert.equal(max_tokens, 600);
      assert.ok(messages.some((m) => m.role === 'system' && m.content === SYSTEM_PROMPT));
      if (calls === 4) {
        assert.ok(messages.some((m) => m.content === 'Просто ме мързи.'));
        assert.ok(messages.some((m) => m.content === 'Ей, направих го.'));
        assert.ok(messages.some((m) => m.content === exchanges[2][1]));
      }
      return { choices: [{ message: { content: exchanges[calls++][1] } }] };
    },
  } } }, id);
  try {
    for (const [question, target] of exchanges) {
      const completion = await client.chat.completions.create({
        model: 'gpt-4o-mini', max_tokens: 600,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...ownerRecentTurns(id),
          { role: 'user', content: question }],
      });
      assert.equal(completion.choices[0].message.content, target);
      ownerRememberTurn(id, 'user', question);
      ownerRememberTurn(id, 'assistant', target);
    }
    assert.equal(calls, exchanges.length);
  } finally {
    clearOwnerTurns(id);
  }
});
