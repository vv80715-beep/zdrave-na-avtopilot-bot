const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryDurableMemoryRepository } = require('../brain/inMemoryDurableMemoryRepository');
const { profileRecord, memoryFact, healthEvent, shortContextRecord } = require('../brain/durableMemoryContracts');
const { createStorageBackedEliBrain } = require('../brain/storageBackedEliBrain');
const { createUnknownHealthProfile, createProfileFieldUpdateProposal, applyApprovedProfileFieldUpdate } = require('../brain/unifiedHealthProfile');
const {
  APPROVED_SUPABASE_PROJECT_REF,
} = require('../brain/eliMemoryClient');
const {
  DURABLE_MEMORY_CONTRACT_VERSION,
} = require('../brain/durableMemoryContracts');

const FLAGS_ON = {
  aiBrain: true,
  contextBuilder: true,
  memoryCandidates: true,
  unifiedProfile: true,
  durableMemory: true,
  durableReads: true,
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
  const brain = createStorageBackedEliBrain({
    repository: repo,
    ownerUserId: '410006',
    backendAccess: {
      ok: true,
      projectRef: APPROVED_SUPABASE_PROJECT_REF,
      contractVersion: DURABLE_MEMORY_CONTRACT_VERSION,
      checkedAt: new Date().toISOString(),
    },
    featureFlags: FLAGS_ON,
    environment: {},
  });
  const result = await brain.prepare({ userId: '410006', channel: 'text', message: 'Как да продължа?' });
  assert.equal(result.context.longTermFacts[0].value, 'кратки отговори');
  assert.equal(result.flags.durableReads, true);
  assert.equal(repo.snapshot().facts.length, 1);
});

test('storage-backed brain never reads durable rows without verified owner access', async () => {
  const repository = createInMemoryDurableMemoryRepository();
  await repository.appendFact(
    memoryFact({ telegramUserId: '410007', category: 'goal', value: 'synthetic fact' })
  );
  let reads = 0;
  const instrumented = {
    ...repository,
    async getProfile(userId) {
      reads += 1;
      return repository.getProfile(userId);
    },
    async listFacts(userId) {
      reads += 1;
      return repository.listFacts(userId);
    },
    async listHealthEvents(userId, limit) {
      reads += 1;
      return repository.listHealthEvents(userId, limit);
    },
    async getShortContext(userId) {
      reads += 1;
      return repository.getShortContext(userId);
    },
  };
  const brain = createStorageBackedEliBrain({
    repository: instrumented,
    ownerUserId: '410007',
    featureFlags: FLAGS_ON,
    environment: {},
  });
  const result = await brain.prepare({
    userId: '410007',
    channel: 'text',
    message: 'Как да продължа?',
  });
  assert.equal(reads, 0);
  assert.equal(result.flags.durableMemory, false);
  assert.equal(result.flags.durableReads, false);
  assert.deepEqual(result.context.longTermFacts, []);
});

test('storage-backed brain does not read durable rows for a different Telegram user', async () => {
  const repository = createInMemoryDurableMemoryRepository();
  await repository.appendFact(
    memoryFact({ telegramUserId: '410008', category: 'goal', value: 'synthetic fact' })
  );
  const access = {
    ok: true,
    projectRef: APPROVED_SUPABASE_PROJECT_REF,
    contractVersion: DURABLE_MEMORY_CONTRACT_VERSION,
    checkedAt: new Date().toISOString(),
  };
  const brain = createStorageBackedEliBrain({
    repository,
    ownerUserId: '410008',
    backendAccess: access,
    featureFlags: FLAGS_ON,
    environment: {},
  });
  const result = await brain.prepare({
    userId: '410009',
    channel: 'text',
    message: 'Как да продължа?',
  });
  assert.equal(result.flags.durableReads, false);
  assert.deepEqual(result.context.longTermFacts, []);
});
