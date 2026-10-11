'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInMemoryDurableMemoryRepository } = require('../brain/inMemoryDurableMemoryRepository');
const { createUniversalMemoryService } = require('../brain/universalMemoryService');
const { createOwnerUniversalMemoryRuntime } = require('../brain/ownerUniversalMemoryRuntime');
const { APPROVED_SUPABASE_PROJECT_REF } = require('../brain/eliMemoryClient');
const { DURABLE_MEMORY_CONTRACT_VERSION } = require('../brain/durableMemoryContracts');

const OWNER = '99000000000000000001';
const FLAGS_ON = {
  ELI_V2_2_OWNER_CANARY_ENABLED: 'true',
  ELI_V2_2_DURABLE_MEMORY_ENABLED: 'true',
  ELI_V2_2_DURABLE_READS_ENABLED: 'true',
};
const verifiedAccess = {
  ok: true,
  projectRef: APPROVED_SUPABASE_PROJECT_REF,
  contractVersion: DURABLE_MEMORY_CONTRACT_VERSION,
  checkedAt: new Date().toISOString(),
};

function fixture({ env = FLAGS_ON, access = verifiedAccess } = {}) {
  let checks = 0;
  const repository = createInMemoryDurableMemoryRepository();
  const service = createUniversalMemoryService({ repository });
  const runtime = createOwnerUniversalMemoryRuntime({
    client: {
      async checkAccess() {
        checks += 1;
        return access;
      },
    },
    service,
    env,
  });
  return { runtime, service, repository, checkCount: () => checks };
}

test('durable owner memory stays inert for customers and while rollout flags are off', async () => {
  const disabled = fixture({ env: {} });
  assert.deepEqual(
    await disabled.runtime.handle({
      userId: OWNER,
      isOwner: true,
      message: 'Запомни, че предпочитам да тренирам на лостове.',
    }),
    { handled: false }
  );
  assert.equal(disabled.checkCount(), 0);

  const enabled = fixture();
  assert.deepEqual(
    await enabled.runtime.handle({
      userId: '99000000000000000002',
      isOwner: false,
      message: 'Запомни, че предпочитам да тренирам на лостове.',
    }),
    { handled: false }
  );
  assert.equal(enabled.checkCount(), 0);
  assert.deepEqual(await enabled.repository.listFacts(OWNER), []);
});

test('owner save, read, update, forget and isolation use the verified durable service', async () => {
  const { runtime, repository } = fixture();
  const send = (message) =>
    runtime.handle({ userId: OWNER, isOwner: true, message });

  const saved = await send('Запомни, че предпочитам да тренирам на лостове.');
  assert.equal(saved.handled, true);
  assert.match(saved.reply, /проверих/i);
  assert.equal((await repository.listFacts(OWNER)).length, 1);

  const recalled = await send('Какъв вид тренировки предпочитам?');
  assert.match(recalled.reply, /лостове/i);

  const edited = await send('Промени предпочитанията за тренировки на йога.');
  assert.match(edited.reply, /Обнових и проверих/i);
  assert.match((await send('Какъв вид тренировки предпочитам?')).reply, /йога/i);

  const forgotten = await send('Забрави предпочитанията за тренировки.');
  assert.match(forgotten.reply, /Изтрих и проверих/i);
  assert.deepEqual(await repository.listFacts(OWNER), []);
  assert.deepEqual(await repository.listFacts('99000000000000000002'), []);
  assert.equal((await send('Какъв вид тренировки предпочитам?')).reply, 'Не открих запазен факт по този въпрос.');
});

test('verified durable facts enter owner context only when read flags and backend are ready', async () => {
  const { runtime, service } = fixture();
  await service.rememberMessage(OWNER, 'Запомни, че предпочитам да тренирам на лостове.');

  const ownerContext = await runtime.prepareContext({
    userId: OWNER,
    isOwner: true,
    message: 'Как да включа повече упражнения в седмичния си план?',
  });
  assert.equal(ownerContext.loaded, true);
  assert.equal(ownerContext.flags.durableReads, true);
  assert.match(ownerContext.facts[0].value, /лостове/);

  const customerContext = await runtime.prepareContext({
    userId: '99000000000000000002',
    isOwner: false,
    message: 'Как да включа повече упражнения в седмичния си план?',
  });
  assert.equal(customerContext.loaded, false);
  assert.deepEqual(customerContext.facts, []);
  assert.equal(customerContext.flags.durableReads, false);
});

test('durable context fails closed when the backend cannot be verified', async () => {
  const { runtime } = fixture({
    access: { ok: false, reason: 'backend_unavailable' },
  });
  const context = await runtime.prepareContext({
    userId: OWNER,
    isOwner: true,
    message: 'Какъв вид тренировки предпочитам?',
  });
  assert.equal(context.loaded, false);
  assert.deepEqual(context.facts, []);
  assert.equal(context.flags.durableReads, false);
});

test('requested owner memory fails closed when approved backend health is unavailable', async () => {
  const { runtime, repository } = fixture({
    access: { ok: false, reason: 'backend_unavailable' },
  });
  const result = await runtime.handle({
    userId: OWNER,
    isOwner: true,
    message: 'Запомни, че предпочитам да тренирам на лостове.',
  });
  assert.equal(result.handled, true);
  assert.equal(result.reason, 'backend_not_ready');
  assert.match(result.reply, /Нищо не е променено/);
  assert.deepEqual(await repository.listFacts(OWNER), []);
});
