const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLogQuery } = require('../dailyLogService');
const { sofiaParts, runtimeContext, withRuntimeContext, shiftDate } = require('../sofiaClock');
const { ownerRememberTurn, ownerRecentTurns, clearOwnerTurns } = require('../ownerSession');
const { createOpenAIClientWrapper } = require('../textAIClient');

for (const question of [
  'Каква тренировка ми препоръчваш да направя днес?',
  'Каква тренировка ми предлагаш да направя днес',
  'Какво да тренирам днес?', 'Предложи ми тренировка',
  'Какво да ям днес?', 'Как да спя по-добре?',
  'Колко вода да пия?', 'Колко стъпки препоръчваш?',
  'А за утре каква тренировка препоръчваш?',
  'нека е нещо леко вкъщи',
  'Не, днес е 29 октомври, а не 16 декември',
  'Кой ден и коя дата е днес?',
]) {
  test(`advice/conversation, not empty log: ${question}`, () => {
    assert.equal(resolveLogQuery(question), null);
  });
}
for (const question of [
  'Какво тренирах днес?', 'Какво записах?', 'Колко вода изпих?',
  'Какво ядох днес?', 'А колко спах?', 'Каква беше последната ми тренировка?',
]) {
  test(`stored facts: ${question}`, () => assert.ok(resolveLogQuery(question)));
}
test('server clock uses Sofia midnight and seasonal offsets', () => {
  assert.deepEqual(sofiaParts(new Date('2026-10-28T22:30:00Z')), { date: '2026-10-29', time: '00:30' });
  assert.deepEqual(sofiaParts(new Date('2026-07-01T21:30:00Z')), { date: '2026-07-02', time: '00:30' });
  assert.match(runtimeContext(new Date('2026-10-29T10:00:00Z')), /четвъртък, 12:00/);
  assert.equal(shiftDate('2026-03-30', -1), '2026-03-29');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
});
test('recommendation, date correction and home-workout follow-up retain bounded history', async () => {
  const id = 'offline-intelligence';
  clearOwnerTurns(id);
  ownerRememberTurn(id, 'user', 'Каква тренировка ми препоръчваш днес?');
  ownerRememberTurn(id, 'assistant', 'Предлагам лека тренировка. Вкъщи ли ще тренираш?');
  ownerRememberTurn(id, 'user', 'Не, сгреши датата.');
  const messages = [...ownerRecentTurns(id), { role: 'user', content: 'нека е нещо леко вкъщи' }];
  let captured;
  const client = createOpenAIClientWrapper({
    chat: { completions: { create: async (request) => {
      captured = request;
      return { choices: [{ message: { content: 'offline fixture' } }] };
    } } },
  }, id, { now: () => Date.parse('2026-10-29T10:00:00Z') });
  await client.chat.completions.create({ model: 'gpt-4o-mini', messages, max_tokens: 250 });
  assert.equal(captured.model, 'gpt-4o-mini');
  assert.equal(captured.max_tokens, 250);
  assert.match(captured.messages[0].content, /Днес=2026-10-29; утре=2026-10-30; вчера=2026-10-28/);
  assert.deepEqual(captured.messages.slice(1), messages);
  assert.match(withRuntimeContext([], new Date('2026-10-30T10:00:00Z'))[0].content, /2026-10-30/);
  clearOwnerTurns(id);
});
