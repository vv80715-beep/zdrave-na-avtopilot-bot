const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-owner-memory-'));
const relationshipPath = path.join(tempDir, 'relationship_memory.json');
const userMemoryPath = path.join(tempDir, 'user_memory.json');
process.env.RELATIONSHIP_MEMORY_PATH = relationshipPath;
process.env.USER_MEMORY_PATH = userMemoryPath;

const {
  rememberFromMessage,
  getRelationshipMemory,
} = require('../relationshipMemory');
const { getOwnerRelationshipMemoryCaptureEnabled } = require('../brain/featureFlags');

const OWNER_ID = 'owner-persistence-fixture';
const OTHER_ID = 'other-persistence-fixture';

function clearFixtures() {
  for (const file of [relationshipPath, userMemoryPath]) {
    if (fs.existsSync(file)) fs.rmSync(file);
  }
}

test.beforeEach(clearFixtures);
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('owner memory capture is opt-in and cannot be enabled for non-owners', () => {
  assert.equal(getOwnerRelationshipMemoryCaptureEnabled(true, {}), false);
  assert.equal(
    getOwnerRelationshipMemoryCaptureEnabled(true, {
      ELI_OWNER_LOCAL_MEMORY_CAPTURE_ENABLED: 'true',
    }),
    true
  );
  assert.equal(
    getOwnerRelationshipMemoryCaptureEnabled(false, {
      ELI_OWNER_LOCAL_MEMORY_CAPTURE_ENABLED: 'true',
    }),
    false
  );
});

test('writes are keyed by Telegram ID and hydrate the owner V2.2 adapter in a new process', () => {
  // Synthetic fixtures only. No historic owner conversation or production data
  // is copied into this temporary store.
  const ownerMessages = [
    'Искам да подобря съня си.',
    'Предпочитанията ми са леща и ябълки.',
    'Отговаряй ми кратко.',
  ];
  for (const message of ownerMessages) {
    assert.equal(rememberFromMessage(OWNER_ID, message).action, 'save');
  }
  assert.equal(rememberFromMessage(OTHER_ID, 'Искам да тренирам редовно.').action, 'save');

  const ownerStored = getRelationshipMemory(OWNER_ID);
  const otherStored = getRelationshipMemory(OTHER_ID);
  assert.equal(ownerStored.length, 3);
  assert.equal(otherStored.length, 1);
  assert.ok(ownerStored.every((entry) => !otherStored.some((other) => other.id === entry.id)));

  const helperPath = require.resolve('../brain/ownerV22Context');
  const adapterPath = require.resolve('../brain/askEliAdapter');
  const flagsPath = require.resolve('../brain/featureFlags');
  const childScript = `
    const { buildOwnerV22Context } = require(${JSON.stringify(helperPath)});
    const { createAskEliAdapter } = require(${JSON.stringify(adapterPath)});
    const { getOwnerScopedEliV22Flags } = require(${JSON.stringify(flagsPath)});
    const ownerId = ${JSON.stringify(OWNER_ID)};
    const context = buildOwnerV22Context(ownerId);
    const prepared = createAskEliAdapter({ environment: {} }).prepare({
      userId: ownerId,
      channel: 'text',
      message: 'Как да подобря съня си и да планирам меню с леща и ябълки?',
      profile: context.profile,
      longTermFacts: context.longTermFacts,
      featureFlags: getOwnerScopedEliV22Flags(true),
    });
    const other = buildOwnerV22Context(${JSON.stringify(OTHER_ID)});
    process.stdout.write(JSON.stringify({
      legacy: prepared.legacy,
      flags: prepared.flags,
      facts: prepared.context.longTermFacts,
      rendered: prepared.systemAddenda.join('\\\\n'),
      otherFacts: other.longTermFacts,
    }));
  `;
  const child = spawnSync(process.execPath, ['-e', childScript], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      RELATIONSHIP_MEMORY_PATH: relationshipPath,
      USER_MEMORY_PATH: userMemoryPath,
    },
    encoding: 'utf8',
  });

  assert.equal(child.status, 0, child.stderr);
  const restored = JSON.parse(child.stdout);
  assert.equal(restored.legacy, false);
  assert.equal(restored.flags.durableMemory, false);
  assert.equal(restored.flags.durableReads, false);
  assert.equal(restored.facts.length, 3);
  assert.ok(restored.facts.some((fact) => /подобрявам съня си/i.test(fact.value)));
  assert.ok(restored.facts.some((fact) => /леща и ябълки/i.test(fact.value)));
  assert.ok(restored.facts.some(
    (fact) => fact.category === 'communication_preferences' && fact.value === 'Кратки отговори'
  ));
  assert.match(restored.rendered, /леща и ябълки/i);
  assert.match(restored.rendered, /Кратки отговори/);
  assert.ok(restored.otherFacts.every(
    (fact) => !ownerStored.some((ownerFact) => ownerFact.value === fact.value)
  ));
});
