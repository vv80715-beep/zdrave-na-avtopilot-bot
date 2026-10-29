// Exercises the actual current askEli and text route, not a parallel implementation.
// Providers are stubs: this proves wiring, not GPT's conversational judgement.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-live-path-'));
for (const key of ['USER_MEMORY_PATH', 'DAILY_LOG_PATH', 'RELATIONSHIP_MEMORY_PATH'])
  process.env[key] = path.join(temp, `${key}.json`);
const persona = require('../persona');
const prompts = require('../prompts');
const ownerSession = require('../ownerSession');
const memory = require('../memoryService');
const storage = require('../memoryStorage');
const logs = require('../dailyLogService');
const { withRuntimeContext } = require('../sofiaClock');
const { createFreeTrialHandoffHandler } = require('../freeTrialHandoff');
const source = fs.readFileSync(require.resolve('../index'), 'utf8');
const slice = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const fixedNow = new Date('2026-10-29T22:30:00Z');
let next = 880001000;
function harness({ owner = true, mode = 'text', plan = 'monthly', blocked = false,
  deliveryOk = true, ai = true } = {}) {
  const id = next++;
  const requests = [], sent = [], routes = {};
  let turns = 0;
  const status = { plan, state: plan === 'free' ? 'trial' : 'paid', canChat: true,
    trialExpiresAt: Date.now() + 60000, allowedModes: plan === 'free' ? ['text'] : ['text', 'voice', 'avatar'] };
  const ctx = { from: { id }, message: {}, reply: async (text, extra) => sent.push({ channel: 'text', text, extra }),
    sendChatAction: async () => {} };
  const gate = async () => { if (blocked) { await ctx.reply('Изтекъл Trial'); return null; } return status; };
  const sandbox = {
    ...persona, ...prompts, ...ownerSession, ...memory, ...storage, ...logs,
    ...require('../relationshipMemory'), ...require('../dailyLogTracker'),
    ...require('../profileIntent'), ...require('../avatarLooks'),
    isOwner: () => owner, gateChat: gate, resolveAccessStatus: gate,
    hasTextAIProvider: () => ai, getMode: () => mode,
    touchConversationState: () => turns++ ? 'continuing' : 'new',
    OWNER_MEMORY: 'Тестова owner идентичност.', OWNER_NAME: 'Тест',
    getOwnerRelationshipMemoryCaptureEnabled: () => false,
    detectOwnerFitnessMemoryCommand: () => null, detectExplicitPreferenceCommand: () => null,
    detectOwnerDossierQuestion: () => null, buildOwnerDossierPrompt: () => '',
    buildOwnerV22Context: () => null,
    ownerUniversalMemoryRuntime: { prepareContext: async () => ({ flags: {}, facts: [] }),
      handle: async () => ({ handled: false }) },
    eliV22Adapter: { prepare: () => ({ legacy: true }), rememberExchange: () => {} },
    replyWithMarkdownSafe: (c, text) => c.reply(text),
    resolveLookId: () => undefined,
    sendVoiceReply: async (_ctx, text) => { if (deliveryOk) sent.push({ channel: 'voice', text }); return deliveryOk; },
    sendAvatarReply: async (_ctx, text) => { if (deliveryOk) sent.push({ channel: 'avatar', text }); return deliveryOk; },
    getTextAIClient: () => ({ chat: { completions: { create: async request => {
      requests.push(JSON.parse(JSON.stringify({ ...request, messages: withRuntimeContext(request.messages, fixedNow) })));
      return { choices: [{ message: { content: 'Тестов отговор без оценка на модела.' } }] };
    } } } }),
    handleFreeTrialHandoff: createFreeTrialHandoffHandler({ ownerTelegramId: owner ? String(id) : '123456789' }),
    maybeHandleCommandText: async () => false,
    bot: { on: (name, fn) => { routes[name] = fn; } },
    console: { error: (...args) => assert.fail(args.join(' ')) },
  };
  vm.runInNewContext(slice('async function askEli(', "bot.command('ask'") +
    slice("bot.on('text',", 'bot.catch('), sandbox);
  return { id, requests, sent, async send(text) {
    ctx.message.text = text;
    const before = sent.length;
    await routes.text(ctx);
    assert.equal(sent.length - before, 1);
    return sent.at(-1);
  }};
}
const sequence = ['Днес не ми се тренира.', 'Просто ме мързи.',
  'Кажи ми честно — търся ли си оправдания?', 'Добре де, какво да направя само за 10 минути?', 'Ей, направих го.'];
for (const owner of [true, false]) for (const mode of ['text', 'voice', 'avatar']) {
  test(`actual history and one completion/delivery: owner=${owner}, mode=${mode}`, async () => {
    const h = harness({ owner, mode });
    for (let i = 0; i < sequence.length; i++) {
      assert.equal((await h.send(sequence[i])).channel, mode);
      const request = h.requests[i];
      assert.equal(request.model, 'gpt-4o-mini');
      assert.equal(request.max_tokens, mode === 'avatar' ? 125 : mode === 'voice' ? 300 : 600);
      assert.deepEqual(request.messages.filter(m => m.role === 'user').map(m => m.content), sequence.slice(0, i + 1));
      assert.equal(request.messages.filter(m => m.role === 'assistant').length, i);
      assert.ok(request.messages.some(m => m.role === 'system' && m.content.includes(persona.SYSTEM_PROMPT)));
    }
    assert.equal(h.requests.length, sequence.length);
  });
}
for (const [name, turns] of [
  ['real fatigue replaces earlier assumption', ['Просто ме мързи.', 'Всъщност почти не съм спал, разбит съм.']],
  ['sadness without pressure', ['Тъжно ми е.', 'Не искам съвети, не ми се обяснява.']],
  ['medical safety after joke', ['Диванът ме държи за заложник 😂', 'Имам силна болка в гърдите и задух.']],
]) test(name, async () => {
  const h = harness({ owner: false });
  for (const text of turns) await h.send(text);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].messages.filter(m => m.role === 'user').map(m => m.content), turns);
  assert.ok(h.requests[1].messages.some(m => m.content.includes(persona.SAFETY)));
});
test('actual diary and advice branches remain separate', async () => {
  const h = harness({ owner: false });
  logs.recordEvents(h.id, [{ category: 'workout', value: '20 минути ходене' }]);
  assert.match((await h.send('Какво тренирах днес?')).text, /20 минути/);
  assert.equal(h.requests.length, 0);
  await h.send('Какво да тренирам днес?');
  assert.equal(h.requests.length, 1);
  assert.match((await h.send('Какво тренирах днес?')).text, /20 минути/);
  assert.equal(h.requests.length, 1);
});
test('Sofia clock outranks old conversation date in the request', async () => {
  const h = harness();
  await h.send('В стария разговор беше 2020-01-01.');
  await h.send('Коя дата сме?');
  assert.match(h.requests[1].messages[0].content, /2026-10-30/);
  assert.match(h.requests[1].messages[0].content, /не дати от стари реплики/);
});
test('short Dani request works for owner and Trial even without AI', async () => {
  for (const owner of [true, false]) for (const ai of [true, false]) {
    const h = harness({ owner, ai, plan: 'free' });
    const reply = await h.send('Искам истински човек');
    assert.equal(reply.extra.reply_markup.inline_keyboard[0][0].url, 'https://t.me/Danail321');
    assert.equal(h.requests.length, 0);
  }
});
test('Trial rights and expired access remain authoritative', async () => {
  for (const mode of ['voice', 'avatar']) {
    const h = harness({ owner: false, plan: 'free', mode });
    assert.equal((await h.send('Нека поговорим.')).channel, 'text');
    assert.equal(h.requests[0].max_tokens, 250);
  }
  const blocked = harness({ owner: false, plan: 'free', blocked: true });
  await blocked.send('Днес не ми се тренира.');
  assert.equal(blocked.requests.length, 0);
});
test('failed premium delivery reuses text with no new completion', async () => {
  for (const mode of ['voice', 'avatar']) {
    const h = harness({ mode, deliveryOk: false });
    assert.equal((await h.send('Нека поговорим.')).channel, 'text');
    assert.equal(h.requests.length, 1);
  }
});
test('four few-shot conversations are system examples, not real memories', () => {
  const { CONVERSATIONS, FEW_SHOT_PROMPT } = require('../personaFewShots');
  assert.equal(CONVERSATIONS.length, 4);
  assert.ok(persona.SYSTEM_PROMPT.includes(FEW_SHOT_PROMPT));
  assert.match(FEW_SHOT_PROMPT, /не факти за сегашния човек/);
  assert.ok(persona.SYSTEM_PROMPT.length < 13742);
});
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
