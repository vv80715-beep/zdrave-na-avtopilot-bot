'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRuntime } = require('../brain/universal/runtime');
const { createFileRepository } = require('../brain/universal/repositories');
const { createAskEliAdapter } = require('../brain/askEliAdapter');
const { getOwnerScopedEliV22Flags } = require('../brain/featureFlags');
const { clearShortContext } = require('../brain/shortContextSession');
const { USER_A, USER_B, answer, rig } = require('./universalMemoryFixtures');

function configuredRuntime(r) {
  return createRuntime({
    environment: { ELI_UNIVERSAL_MEMORY_ENABLED: 'true', ELI_UNIVERSAL_MEMORY_USERS: USER_A, ELI_UNIVERSAL_MEMORY_KEY: r.key },
    openai: r.openai, repositoryFactory: (cipher) => createFileRepository({ directory: r.directory, cipher }),
    importerFactory: async () => async () => [], diagnostic: (e) => r.diagnostics.push(e),
  });
}

function context(id = USER_A) { return { from: { id }, chat: { type: 'private' }, update: { update_id: 51 }, message: { message_id: 51 } }; }

test('default flags are off and enabled rollout requires exact sender allowlist', async (t) => {
  assert.equal(createRuntime({ environment: {} }).active(USER_A), false);
  assert.equal(createRuntime({ environment: { ELI_UNIVERSAL_MEMORY_ENABLED: 'true' } }).active(USER_A), false);
  const r = await rig(t, () => answer()); const runtime = configuredRuntime(r);
  assert.equal(runtime.active(USER_A), true); assert.equal(runtime.active(USER_B), false);
  assert.equal((await runtime.handle(context(USER_B), 'Запомни: собствен факт')).handled, false);
  assert.equal(runtime.status().persistenceVerified, false);
});

test('runtime configuration or database failures consume memory intents without fallback', async () => {
  const runtime = createRuntime({ environment: { ELI_UNIVERSAL_MEMORY_ENABLED: 'true', ELI_UNIVERSAL_MEMORY_USERS: USER_A }, diagnostic: () => {} });
  const result = await runtime.handle(context(), 'Запомни: собствен факт');
  assert.equal(result.handled, true); assert.equal(result.status, 'failed');
  assert.doesNotMatch(result.text, /Записах/);
});

test('rollback disables mutations while migrated users never fall back to old personal facts', async (t) => {
  const r = await rig(t, () => answer({ topic: 'личен факт', evidence: 'предпочитам зеления цвят' }));
  await r.service.handle({ user: USER_A, message: 'Запомни, че предпочитам зеления цвят' });
  const runtime = createRuntime({
    environment: { ELI_UNIVERSAL_MEMORY_ENABLED: 'false', ELI_UNIVERSAL_MEMORY_MIGRATED_USERS: USER_A, ELI_UNIVERSAL_MEMORY_KEY: r.key },
    openai: r.openai, repositoryFactory: (cipher) => createFileRepository({ directory: r.directory, cipher }), importerFactory: async () => async () => [], diagnostic: () => {},
  });
  assert.equal(runtime.active(USER_A), true);
  assert.equal((await runtime.handle(context(), 'Изтрий цялата памет за мен')).status, 'read_only');
  assert.match(await runtime.show(context()), /зеления цвят/);
  assert.equal((await r.repository.read(USER_A)).state.facts.length, 1);
});

test('runtime does not initialize storage or disclose memory in groups', async (t) => {
  const r = await rig(t, () => { throw new Error('never called'); });
  const runtime = configuredRuntime(r); const ctx = context(); ctx.chat.type = 'supergroup';
  assert.equal((await runtime.handle(ctx, 'Запомни: собствен факт')).status, 'private_only');
  assert.match(await runtime.context(ctx, 'факт'), /Не използвай лична памет или частни разговори/); assert.equal(r.openai.calls.length, 0);
});

function askEliHarness(runtime, r, owner, overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const start = source.indexOf('async function askEli(');
  const end = source.indexOf("\nbot.command('ask'", start);
  assert.ok(start > 0 && end > start);
  const failLegacy = () => { throw new Error('legacy personal handler intercepted universal request'); };
  const sandbox = {
    universalMemory: runtime, openai: r.openai,
    gateChat: async () => ({ allowedModes: ['text'], plan: 'free' }),
    isOwner: () => owner, touchConversationState: () => 'continuing', getMode: () => 'text',
    buildOwnerV22Context: failLegacy, handleOwnerGoalMemory: failLegacy,
    eliV22Adapter: createAskEliAdapter({ environment: {} }), getOwnerScopedEliV22Flags,
    detectMemoryCommand: failLegacy, applyMemoryCommand: failLegacy,
    replyWithMarkdownSafe: async (ctx, message) => ctx.replies.push(message),
    clearShortContext, isProfileQuery: () => false,
    addConversation: failLegacy,
    ...overrides,
  };
  vm.createContext(sandbox); vm.runInContext(source.slice(start, end), sandbox);
  return sandbox.askEli;
}

for (const owner of [false, true]) {
  test(`actual askEli handler prioritizes verified universal memory for ${owner ? 'owner' : 'regular user'}`, async (t) => {
    const r = await rig(t, () => answer({ topic: 'любим цвят', evidence: 'любимият ми цвят е зелен' }));
    const askEli = askEliHarness(configuredRuntime(r), r, owner);
    const ctx = { ...context(), replies: [] };
    await askEli(ctx, 'Запомни в дългосрочната си памет, че любимият ми цвят е зелен. Потвърди само ако записът е успешен.');
    assert.equal(ctx.replies.length, 1); assert.match(ctx.replies[0], /Записах и проверих/);
    assert.equal((await r.repository.read(USER_A)).state.facts[0].value, 'любимият ми цвят е зелен');
  });
}

test('actual askEli clear can operate without an AI provider and never erases a health log', async (t) => {
  const r = await rig(t, () => answer()); const runtime = configuredRuntime(r);
  const fake = { ...r, openai: null };
  const askEli = askEliHarness(runtime, fake, false);
  const ctx = { ...context(), replies: [] };
  await askEli(ctx, 'Изтрий цялата памет за мен');
  assert.equal(ctx.replies.length, 1); assert.match(ctx.replies[0], /Изтрих и проверих/);
  assert.match(ctx.replies[0], /Здравният дневник е отделен/);
});

for (const owner of [false, true]) {
  test(`actual group askEli keeps private RAM, canonical facts and owner context out of AI for ${owner ? 'owner' : 'regular user'}`, async (t) => {
    const r = await rig(t, () => { throw new Error('group chat must never select private facts'); });
    const adapter = createAskEliAdapter({ environment: {} });
    adapter.rememberExchange(USER_A, 'private-session-synthetic-value', 'private-session-synthetic-answer');
    t.after(() => clearShortContext(USER_A));
    let captured; let scoped;
    const forbidden = () => { throw new Error('private handler reached from group'); };
    const askEli = askEliHarness(configuredRuntime(r), r, owner, {
      openai: { chat: { completions: { create: async (request) => { captured = request; return { choices: [{ message: { content: 'Синтетичен общ отговор.' } }] }; } } } },
      eliV22Adapter: adapter, getOwnerScopedEliV22Flags: (isScopedOwner) => { scoped = isScopedOwner; return { aiBrain: isScopedOwner, contextBuilder: isScopedOwner }; },
      resolveLogQuery: () => null, extractHealthEvents: () => [],
      SYSTEM_PROMPT: 'generic-safe-context', OWNER_MEMORY: 'private-owner-synthetic-context',
      ownerRecentTurns: () => [{ role: 'user', content: 'private-owner-session-synthetic-value' }], ownerRememberTurn: forbidden,
      conversationFlowNote: () => '', stripLeadingGreeting: (value) => value, parseLookTag: (text) => ({ text, category: 'neutral' }),
      console: { error: forbidden },
    });
    const ctx = { ...context(), chat: { type: 'supergroup' }, replies: [], sendChatAction: async () => {}, reply: async (value) => ctx.replies.push(value) };
    await askEli(ctx, 'Разкажи ми нещо общо за разходките');
    assert.deepEqual(ctx.replies, ['Синтетичен общ отговор.']);
    assert.equal(scoped, false);
    assert.doesNotMatch(JSON.stringify(captured), /private-session|private-owner/);
    assert.match(JSON.stringify(captured), /Не използвай лична памет или частни разговори/);
    assert.equal(r.openai.calls.length, 0);
    assert.equal(adapter.getShortContext(USER_A).length, 2, 'group messages never join the private session');
    assert.equal(await r.repository.read(USER_A), null);
  });
}
