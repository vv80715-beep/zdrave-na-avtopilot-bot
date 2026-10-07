const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Execute the actual registered handlers, without starting Telegram, schedulers,
// providers, or importing any production data stores.
test('/mode -> select Avatar -> как си invokes Avatar, not text delivery', async () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8');
  const between = (start, end) => {
    const a = source.indexOf(start);
    const b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a);
    return source.slice(a, b);
  };
  const commands = new Map(), hears = new Map(), handlers = new Map();
  const modes = new Map();
  const status = { canChat: true, plan: 'owner', allowedModes: ['text', 'voice', 'avatar'] };
  let avatars = 0, voices = 0;
  const replies = [];
  const ctx = {
    from: { id: 900000020 }, message: { text: '/mode' },
    reply: async text => replies.push(text), sendChatAction: async () => {},
  };
  const sandbox = {
    bot: {
      command: (name, fn) => commands.set(name, fn),
      hears: (name, fn) => hears.set(name, fn),
      on: (name, fn) => handlers.set(name, fn),
    },
    Markup: { keyboard: () => ({ resize() { return this; }, oneTime() { return this; } }), removeKeyboard: () => ({}) },
    getMode: id => modes.get(id) || 'text', setMode: (id, mode) => modes.set(id, mode),
    resolveAccessStatus: async () => status, gateChat: async () => status,
    modePermissionsText: () => 'Avatar ✅', planKeyboard: () => ({}),
    maybeHandleCommandText: async () => false,
    isOwner: () => true, touchConversationState: () => 'continuing',
    eliV22Adapter: {
      prepare: () => ({ legacy: true, safety: null, systemAddenda: [] }),
      rememberExchange: () => {},
    },
    isProfileQuery: () => false, resolveLogQuery: () => null,
    extractHealthEvents: () => [], ownerRecentTurns: () => [],
    ownerRememberTurn: () => {}, conversationFlowNote: () => '',
    SYSTEM_PROMPT: 'Mock persona', OWNER_MEMORY: 'Mock owner', LOOK_PROMPT_NOTE: '',
    stripLeadingGreeting: text => text, parseLookTag: text => ({ text, category: 'default' }),
    chooseLookCategory: () => 'default', resolveLookId: () => undefined,
    openai: { chat: { completions: { create: async () => ({
      choices: [{ message: { content: 'Добре съм.' } }],
    }) } } },
    sendAvatarReply: async () => { avatars++; return true; },
    sendVoiceReply: async () => { voices++; return true; },
    console: { error: (...args) => assert.fail(args.join(' ')) },
  };
  vm.runInNewContext(
    between('const MODE_TEXT_LABEL', '// ── Slash-command safety net') +
    between('bot.hears(MODE_TEXT_LABEL', 'myprofile.register') +
    between('async function askEli(', "bot.command('ask'") +
    between("bot.on('text',", 'bot.catch('), sandbox);
  await commands.get('mode')(ctx);
  assert.match(replies.at(-1), /Avatar ✅/);
  await hears.get('Говори с аватара на Ели')(ctx);
  assert.equal(modes.get(ctx.from.id), 'avatar');
  assert.match(replies.at(-1), /кратко видео/);
  replies.length = 0;
  ctx.message.text = 'как си';
  await handlers.get('text')(ctx);
  assert.equal(avatars, 1);
  assert.equal(voices, 0);
  assert.deepEqual(replies, [], 'normal message must not use text delivery');
});