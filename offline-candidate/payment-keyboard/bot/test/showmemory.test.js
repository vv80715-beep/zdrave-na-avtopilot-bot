const test = require('node:test');
const assert = require('node:assert/strict');
const { register } = require('../commands/showmemory');
const { createUnknownHealthProfile, knownField } = require('../brain/unifiedHealthProfile');

function captureHandler(dependencies = {}) {
  let handler;
  register(
    {
      command(name, callback) {
        assert.equal(name, 'showmemory');
        handler = callback;
      },
    },
    dependencies
  );
  return handler;
}

test('/showmemory shows owner facts, not owner role or system instructions', async () => {
  const profile = createUnknownHealthProfile('owner-showmemory-fixture');
  profile.goals.primary = knownField('Покачване на мускулна маса');
  const ownerIdsRead = [];
  const dossierReads = [];
  const handler = captureHandler({
    isOwner: (ctx) => ctx.from.id === 'owner-showmemory-fixture',
    buildOwnerV22Context: (userId) => {
      ownerIdsRead.push(userId);
      return { profile, longTermFacts: [] };
    },
    formatOwnerDossierSummary: (userId) => {
      dossierReads.push(userId);
      return 'Synthetic owner dossier fact.';
    },
    replyWithMarkdownSafe: async (ctx, text) => ctx.replies.push(text),
  });
  const ctx = {
    from: { id: 'owner-showmemory-fixture' },
    session: { __scenes: { current: 'active' } },
    replies: [],
  };

  await handler(ctx);

  assert.deepEqual(ownerIdsRead, ['owner-showmemory-fixture']);
  assert.deepEqual(dossierReads, ['owner-showmemory-fixture']);
  assert.equal(ctx.session.__scenes.current, undefined);
  assert.match(ctx.replies[0], /Покачване на мускулна маса/);
  assert.match(ctx.replies[0], /Целево тегло: не е записано в постоянната памет/);
  assert.match(ctx.replies[0], /Synthetic owner dossier fact/);
  assert.doesNotMatch(
    ctx.replies[0],
    /ВАЖНО — САМОЛИЧНОСТ|Създател|Администратор|Разработчик|пълен достъп|админ команди/i
  );
});

test('/showmemory keeps customer output on the customer memory path', async () => {
  const ownerContextReads = [];
  let dossierReads = 0;
  let customerMemoryRead;
  const handler = captureHandler({
    isOwner: () => false,
    buildOwnerV22Context: (userId) => {
      ownerContextReads.push(userId);
      return { profile: createUnknownHealthProfile(userId), longTermFacts: [] };
    },
    formatOwnerDossierSummary: () => {
      dossierReads += 1;
      return 'must not be read';
    },
    formatFullMemory: (userId) => {
      customerMemoryRead = userId;
      return `Customer memory for ${userId}`;
    },
    replyWithMarkdownSafe: async (ctx, text) => ctx.replies.push(text),
  });
  const ctx = { from: { id: 'customer-showmemory-fixture' }, replies: [] };

  await handler(ctx);

  assert.deepEqual(ownerContextReads, []);
  assert.equal(dossierReads, 0);
  assert.equal(customerMemoryRead, 'customer-showmemory-fixture');
  assert.equal(ctx.replies[0], 'Customer memory for customer-showmemory-fixture');
});
