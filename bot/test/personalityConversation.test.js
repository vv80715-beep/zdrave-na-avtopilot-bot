// Actual askEli control flow and actual history/log helpers, stubbed providers.
// These tests verify wiring and budgets, NOT the live model's judgement.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-personality-'));
const originalEnv = {};
for (const name of ['USER_MEMORY_PATH', 'RELATIONSHIP_MEMORY_PATH', 'DAILY_LOG_PATH', 'OWNER_TELEGRAM_URL']) {
  originalEnv[name] = process.env[name];
}
process.env.USER_MEMORY_PATH = path.join(temp, 'memory.json');
process.env.RELATIONSHIP_MEMORY_PATH = path.join(temp, 'relationship.json');
process.env.DAILY_LOG_PATH = path.join(temp, 'daily.json');
process.env.OWNER_TELEGRAM_URL = 'https://t.me/Danail321';

const persona = require('../persona');
const prompts = require('../prompts');
const ownerSession = require('../ownerSession');
const memoryStorage = require('../memoryStorage');
const memoryService = require('../memoryService');
const dailyLogService = require('../dailyLogService');
const source = fs.readFileSync(require.resolve('../index'), 'utf8');
const start = source.indexOf('async function askEli(');
const end = source.indexOf("bot.command('ask'", start);
assert.ok(start >= 0 && end > start, 'actual askEli function must be found');
const askEliSource = source.slice(start, end);
const fixedNow = new Date('2026-10-29T22:30:00Z');
let nextUser = 890000001;

function harness({ owner = true, mode = 'text', plan = owner ? 'owner' : 'monthly',
  blocked = false, aiAvailable = true, voiceOk = true, avatarOk = true, replies = [] } = {}) {
  const id = nextUser++;
  const requests = [], deliveries = [], errors = [];
  const status = {
    plan, canChat: !blocked,
    allowedModes: plan === 'free' ? ['text'] : plan === 'seven_day' ? ['text', 'voice'] : ['text', 'voice', 'avatar'],
  };
  let inboundTurns = 0;
  const ctx = {
    from: { id }, session: {}, message: {}, update: {},
    reply: async (text, extra) => deliveries.push({ channel: 'text', text, extra }),
    sendChatAction: async () => {},
  };
  const sandbox = {
    ...persona, ...memoryStorage, ...memoryService, ...ownerSession, ...dailyLogService,
    ...require('../relationshipMemory'), ...require('../dailyLogTracker'),
    ...require('../profileIntent'), ...require('../avatarLooks'),
    ...require('../trialHumanHandoff'), ...require('../healthInsights'), ...prompts,
    OWNER_NAME: 'Тест', OWNER_MEMORY: 'Проверена тестова owner идентичност.',
    getMode: () => mode,
    isOwner: () => owner,
    gateChat: async () => {
      if (blocked) { await ctx.reply('Пробният период е изтекъл.'); return null; }
      return status;
    },
    touchConversationState: () => inboundTurns++ ? 'continuing' : 'new',
    conversationFlowNote: state => prompts.conversationFlowNote(state, fixedNow),
    replyWithMarkdownSafe: async (context, text) => context.reply(text),
    sendVoiceReply: async (_context, text) => {
      if (voiceOk) deliveries.push({ channel: 'voice', text });
      return voiceOk;
    },
    sendAvatarReply: async (_context, text) => {
      if (avatarOk) deliveries.push({ channel: 'avatar', text });
      return avatarOk;
    },
    resolveLookId: () => undefined,
    openai: aiAvailable ? { chat: { completions: { create: async request => {
      requests.push(JSON.parse(JSON.stringify(request)));
      return { choices: [{ message: { content: replies.shift() ?? 'Кратък тестов отговор.' } }] };
    } } } } : null,
    console: { error: (...args) => errors.push(args.join(' ')) },
    Date,
  };
  vm.runInNewContext(`${askEliSource}\nthis.runAskEli = askEli;`, sandbox, { timeout: 1000 });
  return {
    id, ctx, status, requests, deliveries, errors,
    async send(text, opts = {}) {
      ctx.message.text = text;
      ctx.update.update_id = (ctx.update.update_id || 0) + 1;
      const before = deliveries.length;
      await sandbox.runAskEli(ctx, text, opts);
      assert.deepEqual(errors, [], 'handler should not swallow an error');
      return deliveries.slice(before);
    },
    history: () => owner ? ownerSession.ownerRecentTurns(id) : memoryService.recentMessages(id, 10),
  };
}

function chatMessages(request) {
  return request.messages.filter(message => message.role !== 'system');
}

for (const owner of [true, false]) {
  for (const mode of ['text', 'voice', 'avatar']) {
    test(`TEST 1–3: laziness → honesty → mini plan → success; ${owner ? 'owner RAM' : 'user stored history'}, ${mode}`, async () => {
      const h = harness({ owner, mode });
      const userTurns = [
        'Днес не ми се тренира.', 'Просто ме мързи.',
        'Кажи ми честно — търся ли си оправдания?',
        'Добре де, какво да направя само за 10 минути?', 'Ей, направих го.',
      ];
      for (const text of userTurns) {
        const sent = await h.send(text);
        assert.equal(sent.length, 1, 'one delivery per turn');
        assert.equal(sent[0].channel, mode);
      }
      assert.equal(h.requests.length, userTurns.length, 'one completion per conversational turn');
      for (let i = 0; i < userTurns.length; i++) {
        const request = h.requests[i];
        assert.equal(request.model, 'gpt-4o-mini');
        assert.equal(request.max_tokens, mode === 'avatar' ? 125 : mode === 'voice' ? 300 : 600);
        assert.deepEqual(chatMessages(request).filter(message => message.role === 'user').map(message => message.content), userTurns.slice(0, i + 1));
        assert.ok(request.messages[0].content.includes(persona.SYSTEM_PROMPT), 'same shared personality');
        assert.equal(request.messages.length, 2 + 2 * i, 'examples are not inserted as real chat history');
      }
      assert.equal(h.history().length, 10);
    });
  }
}

test('TEST 4: new exhaustion reaches the next completion beside the earlier laziness context', async () => {
  const h = harness();
  await h.send('Просто ме мързи.');
  await h.send('Днес съм наистина разбит, почти не съм спал.');
  const request = h.requests.at(-1);
  assert.equal(chatMessages(request)[0].content, 'Просто ме мързи.');
  assert.equal(chatMessages(request).at(-1).content, 'Днес съм наистина разбит, почти не съм спал.');
  assert.ok(request.messages[0].content.includes(persona.GENTLE_GUIDANCE));
  assert.match(request.messages[0].content, /По-ново уточнение поправя старата/);
});

test('TEST 5: sadness and refusing advice retain context without extra calls or deliveries', async () => {
  const h = harness({ owner: false });
  await h.send('Днес просто ми е тежко.');
  await h.send('Не ми се обяснява, не искам съвети.');
  assert.equal(h.requests.length, 2);
  assert.equal(h.deliveries.length, 2);
  assert.equal(chatMessages(h.requests[1])[0].content, 'Днес просто ми е тежко.');
  assert.match(h.requests[1].messages[0].content, /Уважавай „не искам съвети"/);
});

test('TEST 6: casual humor stays in history and does not manufacture a diary entry', async () => {
  const h = harness();
  await h.send('Диванът ме държи за заложник 😂');
  await h.send('Шегувам се, ставам.');
  assert.equal(h.requests.length, 2);
  assert.equal(chatMessages(h.requests[1])[0].content, 'Диванът ме държи за заложник 😂');
  const stored = dailyLogService.answerDailyLogQuery(h.id, dailyLogService.resolveLogQuery('Какво тренирах днес?'));
  assert.match(stored, /Няма записани данни/);
});

test('TEST 7: medical safety stays intact after a joke; provider output is not restyled', async () => {
  const h = harness({ replies: ['Кратък отговор.', 'Обади се на 112 веднага.'] });
  await h.send('Шегувам се за дивана.');
  const sent = await h.send('Сега имам силна болка в гърдите и задух.');
  assert.ok(h.requests.at(-1).messages[0].content.includes(persona.SAFETY));
  assert.equal(h.requests.at(-1).messages.at(-1).content, 'Сега имам силна болка в гърдите и задух.');
  assert.equal(sent[0].text, 'Обади се на 112 веднага.');
  assert.equal(h.requests.length, 2);
});

test('TEST 8: diary read and advice follow separate real routes; proposals never become reports', async () => {
  const h = harness({ owner: false });
  dailyLogService.recordEvents(h.id, [{ category: 'workout', value: '20 минути ходене' }]);
  const stored = await h.send('Какво тренирах днес?');
  assert.equal(h.requests.length, 0);
  assert.match(stored[0].text, /20 минути ходене/);
  await h.send('Какво да тренирам днес?');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].messages.at(-1).content, 'Какво да тренирам днес?');
  assert.equal(chatMessages(h.requests[0])[0].content, 'Какво тренирах днес?');
  const storedAgain = await h.send('Какво тренирах днес?');
  assert.equal(h.requests.length, 1);
  assert.equal(storedAgain[0].text, stored[0].text);
});

test('TEST 8b: water is read from storage without an AI completion', async () => {
  const h = harness();
  dailyLogService.recordEvents(h.id, [{ category: 'water', value: '500 мл', amount: 500, unit: 'мл' }]);
  const sent = await h.send('Колко вода изпих днес?');
  assert.equal(h.requests.length, 0);
  assert.match(sent[0].text, /500 мл/);
});

test('TEST 9: date request receives Sofia server context despite an old date in history', async () => {
  const h = harness({ replies: ['Тестова реплика.', 'Днес е 30 октомври 2026 г.'] });
  await h.send('В един стар разговор беше 2020-01-01.');
  await h.send('Коя дата сме?');
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests[1].messages[0].content.includes(prompts.currentClockNote(fixedNow)));
  assert.match(h.requests[1].messages[0].content, /2026-10-30, 00:30/);
});

test('TEST 10: exact short human request bypasses AI with the public Dani URL, including an outage', async () => {
  for (const aiAvailable of [true, false]) {
    const h = harness({ owner: false, plan: 'free', aiAvailable });
    const sent = await h.send('Искам истински човек.');
    assert.equal(h.requests.length, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Дани/);
    const button = sent[0].extra.reply_markup.inline_keyboard[0][0];
    assert.equal(button.text, '👤 Свържи се с Дани');
    assert.equal(button.url, 'https://t.me/Danail321');
  }
});

test('blocked access never reaches personality, history, or providers', async () => {
  const h = harness({ owner: false, plan: 'free', blocked: true });
  await h.send('Днес не ми се тренира.');
  assert.equal(h.requests.length, 0);
  assert.equal(h.history().length, 0);
  assert.equal(h.deliveries.length, 1);
});

test('trial remains text-only with its original cap after stale premium mode or spoken input', async () => {
  for (const mode of ['voice', 'avatar']) {
    const h = harness({ owner: false, mode, plan: 'free' });
    await h.send('Кажи ми нещо кратко.', { spokenInput: true });
    assert.equal(h.requests[0].max_tokens, 250);
    assert.equal(h.requests[0].model, 'gpt-4o-mini');
    assert.equal(h.deliveries[0].channel, 'text');
  }
});

test('premium failure falls back to the same text without another completion', async () => {
  for (const mode of ['voice', 'avatar']) {
    const h = harness({ mode, voiceOk: false, avatarOk: false, replies: ['Един тестов отговор.'] });
    const sent = await h.send('Продължаваме разговора.');
    assert.equal(h.requests.length, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, 'text');
    assert.equal(sent[0].text, 'Един тестов отговор.');
  }
});

test('history stays bounded and private between users after more than five exchanges', async () => {
  const a = harness({ owner: false }), b = harness({ owner: false });
  for (let i = 0; i < 8; i++) await a.send(`Лична тестова тема ${i}.`);
  await b.send('Моята отделна тема.');
  assert.equal(chatMessages(a.requests.at(-1)).length, 11);
  assert.equal(chatMessages(b.requests[0]).length, 1);
  assert.doesNotMatch(JSON.stringify(chatMessages(b.requests[0])), /Лична тестова тема/);
});

test.after(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(temp, { recursive: true, force: true });
});
