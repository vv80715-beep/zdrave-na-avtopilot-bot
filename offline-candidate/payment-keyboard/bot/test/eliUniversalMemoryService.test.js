'use strict';

// The classifier is exercised with its real rules, but all persistence in this
// test file is an injected fixture repository under the OS temp directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-v22-memory-service-'));
process.env.RELATIONSHIP_MEMORY_PATH = path.join(tempDir, 'relationship-memory.json');
process.env.DAILY_LOG_PATH = path.join(tempDir, 'daily-logs.json');
process.env.USER_MEMORY_PATH = path.join(tempDir, 'user-memory.json');

const { createInMemoryDurableMemoryRepository } = require('../brain/inMemoryDurableMemoryRepository');
const { createUniversalMemoryService } = require('../brain/universalMemoryService');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('explicit workout preference is saved and recalled from the same user scope', async () => {
  const repository = createInMemoryDurableMemoryRepository();
  const memory = createUniversalMemoryService({ repository });

  const saved = await memory.rememberMessage(
    '510001',
    'Запомни, че предпочитам да тренирам на лостове.'
  );
  assert.equal(saved.ok, true);
  assert.equal(saved.confirmed, true);
  assert.equal(saved.fact.category, 'personal_preferences');

  const recalled = await memory.recall('510001', 'Какъв вид тренировки предпочитам?');
  assert.equal(recalled.ok, true);
  assert.equal(recalled.facts.length, 1);
  assert.match(recalled.facts[0].value, /лостове/i);
});

test('facts are isolated by Telegram user ID', async () => {
  const repository = createInMemoryDurableMemoryRepository();
  const memory = createUniversalMemoryService({ repository });
  await memory.rememberMessage('510011', 'Искам да подобря съня си.');
  await memory.rememberMessage('510012', 'Искам да кача мускулна маса.');

  const first = await memory.recall('510011', 'Каква е целта ми за съня?');
  const second = await memory.recall('510012', 'Каква е целта ми за мускулна маса?');
  assert.equal(first.facts.length, 1);
  assert.equal(second.facts.length, 1);
  assert.equal(first.facts[0].telegramUserId, '510011');
  assert.equal(second.facts[0].telegramUserId, '510012');
});

test('a reported health event is not stored as relationship memory', async () => {
  const repository = createInMemoryDurableMemoryRepository();
  const memory = createUniversalMemoryService({ repository });

  const result = await memory.rememberMessage('510021', 'Изпих 2 литра вода днес.');
  assert.equal(result.ok, false);
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'not_a_memory_candidate');
  assert.deepEqual(await repository.listFacts('510021'), []);
  assert.deepEqual(await repository.listHealthEvents('510021'), []);
});

test('edit and forget are confirmed only after read-back verification', async () => {
  const repository = createInMemoryDurableMemoryRepository();
  const memory = createUniversalMemoryService({ repository });
  await memory.rememberMessage('510031', 'Запомни, че предпочитам да тренирам на лостове.');

  const edited = await memory.edit('510031', 'предпочитания за тренировки', 'Йога');
  assert.equal(edited.ok, true);
  assert.equal(edited.confirmed, true);
  assert.equal(edited.fact.value, 'Йога');

  const forgotten = await memory.forget('510031', 'предпочитания за тренировки');
  assert.equal(forgotten.ok, true);
  assert.equal(forgotten.confirmed, true);
  assert.deepEqual(await repository.listFacts('510031'), []);
});

test('ambiguous edit and forget requests do not choose an arbitrary fact', async () => {
  const repository = createInMemoryDurableMemoryRepository();
  const memory = createUniversalMemoryService({ repository });
  await memory.rememberMessage('510041', 'Предпочитам да тренирам на лостове.');
  await memory.rememberMessage('510041', 'Предпочитам да тренирам с тежести.');

  const edit = await memory.edit('510041', 'тренировки', 'Йога');
  const forget = await memory.forget('510041', 'тренировки');
  assert.equal(edit.reason, 'ambiguous_target');
  assert.equal(forget.reason, 'ambiguous_target');
  assert.equal(edit.confirmed, false);
  assert.equal(forget.confirmed, false);
  assert.equal((await repository.listFacts('510041')).length, 2);
});

test('storage failure never returns a successful memory confirmation', async () => {
  const repository = createInMemoryDurableMemoryRepository();
  repository.appendFact = async () => {
    throw new Error('fixture-only write failure');
  };
  const memory = createUniversalMemoryService({ repository });

  const result = await memory.rememberMessage(
    '510051',
    'Запомни, че предпочитам да тренирам на лостове.'
  );
  assert.equal(result.ok, false);
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'storage_unavailable');
});

function createFileBackedMockRepository(filePath) {
  function read() {
    if (!fs.existsSync(filePath)) return { facts: [] };
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  function write(state) {
    fs.writeFileSync(filePath, JSON.stringify(state), 'utf8');
  }
  return {
    async listFacts(userId) {
      return read().facts.filter(
        (fact) => fact.telegramUserId === String(userId) && fact.status === 'active'
      );
    },
    async appendFact(record) {
      const state = read();
      const fact = {
        ...record,
        id: `fixture-${state.facts.length + 1}`,
        status: 'active',
      };
      state.facts.push(fact);
      write(state);
      return fact;
    },
    async updateFact(userId, factId, changes) {
      const state = read();
      const fact = state.facts.find(
        (item) =>
          item.telegramUserId === String(userId) &&
          item.id === String(factId) &&
          item.status === 'active'
      );
      if (!fact) return null;
      Object.assign(fact, changes);
      write(state);
      return fact;
    },
    async deleteFact(userId, factId) {
      const state = read();
      const fact = state.facts.find(
        (item) =>
          item.telegramUserId === String(userId) &&
          item.id === String(factId) &&
          item.status === 'active'
      );
      if (!fact) return null;
      fact.status = 'deleted';
      write(state);
      return fact;
    },
  };
}

test('synthetic file-backed repository survives a service/repository restart', async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-v22-restart-fixture-'));
  const fixturePath = path.join(fixtureDir, 'synthetic-facts.json');
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

  const firstService = createUniversalMemoryService({
    repository: createFileBackedMockRepository(fixturePath),
  });
  const saved = await firstService.rememberMessage(
    '510061',
    'Запомни, че предпочитам да тренирам на лостове.'
  );
  assert.equal(saved.confirmed, true);

  const restartedService = createUniversalMemoryService({
    repository: createFileBackedMockRepository(fixturePath),
  });
  const recalled = await restartedService.recall(
    '510061',
    'Какъв вид тренировки предпочитам?'
  );
  assert.equal(recalled.ok, true);
  assert.equal(recalled.facts.length, 1);
  assert.match(recalled.facts[0].value, /лостове/i);
});
