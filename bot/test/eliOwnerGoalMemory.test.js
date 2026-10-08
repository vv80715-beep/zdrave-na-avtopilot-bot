'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-owner-goal-'));
const ownerId = String(930000000 + process.pid);
const customerId = String(940000000 + process.pid);
process.env.OWNER_TELEGRAM_ID = ownerId;
process.env.RELATIONSHIP_MEMORY_PATH = path.join(tmp, 'relationship-memory.json');
process.env.USERS_PATH = path.join(tmp, 'users.json');
process.env.USER_MEMORY_PATH = path.join(tmp, 'user-memory.json');
process.env.DAILY_LOG_PATH = path.join(tmp, 'daily.json');

const {
  detectOwnerGoalIntent,
  handleOwnerGoalMemory,
  formatOwnerStoredSummary,
} = require('../brain/ownerGoalMemory');
const { resolveLogQuery } = require('../dailyLogService');
const { getUserMemories } = require('../relationshipMemoryStorage');

const recall = 'Ели, какво помниш за моята основна фитнес цел? Колко килограма искам да достигна?';
const save = 'Ели, искам да запомниш в дългосрочната си памет, че основната ми фитнес цел е да кача мускулна маса и да достигна 65 кг. Потвърди ми дали информацията е записана успешно.';

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('real owner fitness recall is not classified as daily-log weight and workout', () => {
  assert.deepEqual(detectOwnerGoalIntent(recall), { type: 'recall_goal' });
  assert.equal(resolveLogQuery(recall), null);
  assert.equal(resolveLogQuery('Ели, каква е основната ми фитнес цел и колко килограма искам да достигна?'), null);
  assert.equal(resolveLogQuery('Ели, какво е теглото ми днес?')?.kind, 'category');
});

test('owner explicit save is persisted, verified, deduplicated, and recalled', () => {
  assert.match(handleOwnerGoalMemory(ownerId, recall), /нямам записана/);
  assert.match(handleOwnerGoalMemory(ownerId, save), /Записах успешно/);
  assert.match(handleOwnerGoalMemory(ownerId, recall), /65 кг/);
  assert.match(handleOwnerGoalMemory(ownerId, recall), /мускулна маса/);
  assert.equal(getUserMemories(ownerId).length, 1);
  assert.match(handleOwnerGoalMemory(ownerId, save), /Записах успешно/);
  assert.equal(getUserMemories(ownerId).length, 1);
  assert.equal(handleOwnerGoalMemory(customerId, save), null);
  assert.deepEqual(getUserMemories(customerId), []);

  // Existing local JSON is reread each request, surviving module state reset.
  assert.match(fs.readFileSync(process.env.RELATIONSHIP_MEMORY_PATH, 'utf8'), /65 кг/);
});

test('owner summary uses persisted facts, never internal owner instructions', () => {
  const summary = formatOwnerStoredSummary(ownerId);
  assert.match(summary, /65 кг/);
  assert.doesNotMatch(summary, /САМОЛИЧНОСТ НА ПОТРЕБИТЕЛЯ|пълен достъп|админ команди/);
  assert.match(formatOwnerStoredSummary(customerId), /Нямаш достъп/);
});

test('save with unsupported facts cannot fabricate a successful memory', () => {
  const unsupported = 'Ели, запомни моята фитнес цел';
  assert.match(handleOwnerGoalMemory(ownerId, unsupported), /Кажи ми конкретната/);
  assert.equal(getUserMemories(ownerId).length, 1);
});

test('generic greetings and health reports are not memory requests', () => {
  assert.equal(detectOwnerGoalIntent('оп'), null);
  assert.equal(resolveLogQuery('оп'), null);
  assert.equal(detectOwnerGoalIntent('Тежа 60 кг'), null);
});
