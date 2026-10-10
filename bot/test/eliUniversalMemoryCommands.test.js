'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRuntime } = require('../brain/universal/runtime');
const { createFileRepository } = require('../brain/universal/repositories');
const { USER_A, answer, rig } = require('./universalMemoryFixtures');

function moduleAt(name, dependencies) {
  const sandbox = { module: { exports: {} }, console, __dirname: path.join(__dirname, '../commands'), require: (key) => {
    if (!Object.hasOwn(dependencies, key)) throw new Error(`unexpected dependency ${key}`);
    return dependencies[key];
  } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../commands', name), 'utf8'), sandbox);
  return sandbox.module.exports;
}

function botFor(module) {
  const handlers = {};
  module.register({ command: (key, value) => { handlers[key] = value; }, action: (key, value) => { handlers[key] = value; } });
  return handlers;
}

function ctx(type = 'private') {
  const replies = [];
  return { from: { id: USER_A }, chat: { type }, replies, session: {}, reply: async (s) => replies.push(s), editMessageText: async (s) => replies.push(s), answerCbQuery: async () => {}, sendChatAction: async () => {} };
}

function runtimeFor(r) {
  return createRuntime({ environment: { ELI_UNIVERSAL_MEMORY_ENABLED: 'true', ELI_UNIVERSAL_MEMORY_USERS: USER_A, ELI_UNIVERSAL_MEMORY_KEY: r.key }, openai: r.openai, repositoryFactory: (cipher) => createFileRepository({ directory: r.directory, cipher }), importerFactory: async () => async () => [], diagnostic: () => {} });
}

test('actual showmemory command reads canonical facts before the owner or legacy summary', async (t) => {
  const r = await rig(t, () => answer({ topic: 'нов факт', evidence: 'наричам телескопа си Северна искра' }));
  await r.service.handle({ user: USER_A, message: 'Запомни, че наричам телескопа си Северна искра' });
  const runtime = runtimeFor(r); const forbidden = () => { throw new Error('stale summary'); };
  const command = moduleAt('showmemory.js', {
    '../adminGuard': { isOwner: () => true }, '../brain/ownerGoalMemory': { formatOwnerStoredSummary: forbidden },
    '../memoryService': { formatFullMemory: forbidden }, '../replyUtils': { replyWithMarkdownSafe: (c, s) => c.reply(s) },
    '../brain/universal/runtime': { getUniversalMemoryRuntime: () => runtime },
  });
  const handlers = botFor(command); const c = ctx(); await handlers.showmemory(c);
  assert.match(c.replies[0], /Северна искра/);
  const group = ctx('group'); await handlers.showmemory(group); assert.doesNotMatch(group.replies[0], /Северна искра/);
});

test('actual forget command and stale button cannot touch legacy personal or health data', async (t) => {
  const r = await rig(t, () => answer()); const runtime = runtimeFor(r);
  const forbidden = () => { throw new Error('legacy deletion touched'); };
  const command = moduleAt('forget.js', {
    telegraf: { Markup: {} }, '../adminGuard': { isOwner: () => false }, '../memoryStorage': { deleteMemory: forbidden },
    '../dailyLogStorage': { deleteUserLog: forbidden }, '../brain/universal/runtime': { getUniversalMemoryRuntime: () => runtime },
  });
  const handlers = botFor(command); const c = ctx(); await handlers.forget(c); await handlers.forget_yes(c);
  assert.equal(c.replies.length, 2); assert.match(c.replies[0], /Изтрий цялата памет/);
  assert.equal(await r.repository.read(USER_A), null);
});

test('actual plan command uses canonical preferences and separate health measurements', async (t) => {
  const r = await rig(t, ({ operation, facts }) => operation === 'remember' ? answer({ topic: 'спорт', evidence: 'предпочитам да тренирам на лостове' }) : answer({ selectedIds: facts.map((f) => f.id) }));
  await r.service.handle({ user: USER_A, message: 'Запомни, че предпочитам да тренирам на лостове' });
  const runtime = runtimeFor(r); const generated = []; const saved = [];
  const command = moduleAt('plan.js', {
    '../storage': { getUser: () => ({ firstName: 'STALE_NAME', goal: 'STALE_GOAL', foodPreferences: 'STALE_FOOD', age: 30, height: 170, weight: 70 }) },
    '../prompts': { SYSTEM_PROMPT: 'system', stripLeadingGreeting: (s) => s },
    '../openaiClient': { chat: { completions: { create: async (request) => { generated.push(request); return { choices: [{ message: { content: 'Синтетичен план' } }] }; } } } },
    '../memoryStorage': { addPlan: (id, summary) => saved.push(summary) }, '../adminGuard': { isOwner: () => false },
    '../chatGate': { gateChat: async () => ({}) }, '../brain/universal/runtime': { getUniversalMemoryRuntime: () => runtime },
  });
  const handlers = botFor(command); const c = ctx(); await handlers.plan(c);
  assert.equal(generated.length, 1);
  const data = JSON.stringify(generated[0].messages);
  assert.match(data, /лостове/); assert.match(data, /170/); assert.doesNotMatch(data, /STALE_NAME|STALE_GOAL|STALE_FOOD/);
  assert.equal(saved[0], 'Създаден 7-дневен план');
  await handlers.plan(ctx('supergroup')); assert.equal(generated.length, 1);
});

test('actual coaching commands cannot expose canonical personal facts in a group', async (t) => {
  const r = await rig(t, () => answer()); const runtime = runtimeFor(r);
  const forbidden = () => { throw new Error('private facts requested by group command'); };
  const command = moduleAt('coach.js', {
    '../openaiClient': {}, '../adminGuard': { isOwner: () => false }, '../chatGate': { gateChat: forbidden },
    '../coachService': { generateCoach: forbidden, generateMotivate: forbidden, generateNextStep: forbidden, generateWeeklyReview: forbidden },
    '../brain/universal/runtime': { getUniversalMemoryRuntime: () => runtime },
  });
  for (const handler of Object.values(botFor(command))) {
    const c = ctx('group'); await handler(c); assert.match(c.replies[0], /личния чат/);
  }
});
