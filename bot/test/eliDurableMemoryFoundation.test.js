const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryDurableMemoryRepository } = require('../brain/inMemoryDurableMemoryRepository');
const { profileRecord, memoryFact, healthEvent, shortContextRecord } = require('../brain/durableMemoryContracts');
const { createStorageBackedEliBrain } = require('../brain/storageBackedEliBrain');
const { createUnknownHealthProfile, createProfileFieldUpdateProposal, applyApprovedProfileFieldUpdate } = require('../brain/unifiedHealthProfile');

const FLAGS_ON = {
  aiBrain: true,
  contextBuilder: true,
  memoryCandidates: true,
  unifiedProfile: true,
};

test('durable repository isolates users', async () => {
  const repo = createInMemoryDurableMemoryRepository();
  await repo.appendFact(memoryFact({ telegramUserId: '410001', category: 'goal', value: 'сън' }));
  await repo.appendFact(memoryFact({ telegramUserId: '410002', category: 'goal', value: 'маса' }));
  assert.equal((await repo.listFacts('410001'))[0].value, 'сън');
  assert.equal((await repo.listFacts('410002'))[0].value, 'маса');
});

test('profile contract is versioned', async () => {
  const repo = createInMemoryDurableMemoryRepository();
  const profile = createUnknownHealthProfile('410003');
  const proposal = createProfileFieldUpdateProposal(profile, 'goals.primary', 'да ходя повече');
  const updated = applyApprovedProfileFieldUpdate(profile, proposal).profile;
  const record = profileRecord({ telegramUserId: '410003', profile: updated, version: 2 });
  await repo.putProfile(record);
  assert.equal((await repo.getProfile('410003')).version, 2);
});

test('health events are append-only in repository contract', async () => {
  const repo = createInMemoryDurableMemoryRepository();
  await repo.appendHealthEvent(healthEvent({ telegramUserId: '410004', type: 'water', value: 2, unit: 'cups' }));
  await repo.appendHealthEvent(healthEvent({ telegramUserId: '410004', type: 'walk', value: 20, unit: 'min' }));
  assert.equal((await repo.listHealthEvents('410004')).length, 2);
});

test('short context contract stays bounded to ten turns', async () => {
  const repo = createInMemoryDurableMemoryRepository();
  const record = shortContextRecord({
    telegramUserId: '410005',
    messages: Array.from({ length: 13 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) })),
  });
  await repo.putShortContext(record);
  const stored = await repo.getShortContext('410005');
  assert.equal(stored.messages.length, 10);
  assert.equal(stored.messages[0].content, '3');
});

test('storage-backed brain reads common durable context without writes', async () => {
  const repo = createInMemoryDurableMemoryRepository();
  await repo.appendFact(memoryFact({ telegramUserId: '410006', category: 'communication', value: 'кратки отговори' }));
  const brain = createStorageBackedEliBrain({ repository: repo, featureFlags: FLAGS_ON, environment: {} });
  const result = await brain.prepare({ userId: '410006', channel: 'text', message: 'Как да продължа?' });
  assert.equal(result.context.longTermFacts[0].value, 'кратки отговори');
  assert.equal(repo.snapshot().facts.length, 1);
});
