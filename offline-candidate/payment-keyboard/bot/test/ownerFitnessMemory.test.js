const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const previousOwnerId = process.env.OWNER_TELEGRAM_ID;
const previousMemoryPath = process.env.RELATIONSHIP_MEMORY_PATH;
const OWNER_ID = 'fitness-memory-owner-fixture';
const OTHER_ID = 'fitness-memory-other-fixture';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-owner-fitness-memory-'));
const memoryPath = path.join(tempDir, 'relationship_memory.json');
process.env.OWNER_TELEGRAM_ID = OWNER_ID;
process.env.RELATIONSHIP_MEMORY_PATH = memoryPath;

const {
  detectOwnerFitnessMemoryCommand,
  saveOwnerFitnessGoal,
} = require('../ownerFitnessMemory');
const { getRelationshipMemory } = require('../relationshipMemory');
const { isProfileQuery } = require('../profileIntent');
const { buildOwnerV22Context } = require('../brain/ownerV22Context');
const { formatOwnerPersonalMemory } = require('../brain/ownerMemorySummary');

function clearStore() {
  if (fs.existsSync(memoryPath)) fs.rmSync(memoryPath);
}

test.beforeEach(clearStore);
test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (previousOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
  else process.env.OWNER_TELEGRAM_ID = previousOwnerId;
  if (previousMemoryPath === undefined) delete process.env.RELATIONSHIP_MEMORY_PATH;
  else process.env.RELATIONSHIP_MEMORY_PATH = previousMemoryPath;
});

test('fitness-goal save parser accepts explicit Bulgarian forms and rejects ordinary log messages', () => {
  const cases = [
    [
      'Запомни, че фитнес целта ми е да кача мускулна маса и целевото ми тегло е 75 кг.',
      'кача мускулна маса',
      '75',
    ],
    [
      'Искам да запомниш: основната ми фитнес цел е да отслабна, а да стигна до 68.5 кг.',
      'отслабна',
      '68.5',
    ],
    [
      'Запиши ми фитнес целта: да пробягам 5 км, целево тегло 72 кг.',
      'пробягам 5 км',
      '72',
    ],
    [
      'Промени фитнес целта ми на подобряване на издръжливостта и целевото тегло на 70 кг.',
      'подобряване на издръжливостта',
      '70',
    ],
  ];

  for (const [text, goal, targetWeightKg] of cases) {
    assert.deepEqual(detectOwnerFitnessMemoryCommand(text), {
      kind: 'save_fitness_goal',
      goal,
      targetWeightKg,
    });
  }
  assert.equal(
    detectOwnerFitnessMemoryCommand('Днес тежах 75 кг и тренирах.'),
    null
  );
  assert.equal(
    detectOwnerFitnessMemoryCommand('Искам да стигна до 75 кг.'),
    null,
    'a goal statement without an explicit memory command is not saved'
  );

  const incomplete = detectOwnerFitnessMemoryCommand(
    'Запомни, че фитнес целта ми е да кача мускулна маса.'
  );
  assert.equal(incomplete.goal, 'кача мускулна маса');
  assert.equal(incomplete.targetWeightKg, null);
});

test('owner-only save is idempotent, updates managed facts, and leaves other users isolated', () => {
  const first = saveOwnerFitnessGoal(OWNER_ID, {
    kind: 'save_fitness_goal',
    goal: 'кача мускулна маса',
    targetWeightKg: '75',
  });
  assert.deepEqual(first, {
    ok: true,
    goal: 'кача мускулна маса',
    targetWeightKg: '75',
  });

  const initial = getRelationshipMemory(OWNER_ID);
  assert.equal(initial.length, 2);
  assert.deepEqual(
    initial.map(({ category, value }) => [category, value]),
    [
      ['goals', 'Основна фитнес цел: кача мускулна маса'],
      ['goals', 'Целево тегло: 75 кг'],
    ]
  );
  assert.deepEqual(getRelationshipMemory(OTHER_ID), []);

  const duplicate = saveOwnerFitnessGoal(OWNER_ID, {
    kind: 'save_fitness_goal',
    goal: 'кача мускулна маса',
    targetWeightKg: '75',
  });
  assert.equal(duplicate.ok, true);
  assert.equal(getRelationshipMemory(OWNER_ID).length, 2, 'repeat saves do not add copies');

  const updated = saveOwnerFitnessGoal(OWNER_ID, {
    kind: 'save_fitness_goal',
    goal: 'подобря силата си',
    targetWeightKg: '72.5',
  });
  assert.deepEqual(updated, {
    ok: true,
    goal: 'подобря силата си',
    targetWeightKg: '72.5',
  });
  const afterUpdate = getRelationshipMemory(OWNER_ID);
  assert.equal(afterUpdate.length, 2, 'updates replace only the managed goal/weight facts');
  assert.ok(afterUpdate.some((entry) => entry.value === 'Основна фитнес цел: подобря силата си'));
  assert.ok(afterUpdate.some((entry) => entry.value === 'Целево тегло: 72.5 кг'));
  assert.deepEqual(getRelationshipMemory(OTHER_ID), []);
});

test('save rejects a non-owner and invalid or out-of-range facts without writing', () => {
  const command = {
    kind: 'save_fitness_goal',
    goal: 'кача мускулна маса',
    targetWeightKg: '75',
  };
  assert.deepEqual(saveOwnerFitnessGoal(OTHER_ID, command), {
    ok: false,
    reason: 'unauthorized',
  });
  assert.deepEqual(saveOwnerFitnessGoal(OWNER_ID, { ...command, targetWeightKg: '5' }), {
    ok: false,
    reason: 'invalid',
  });
  assert.deepEqual(saveOwnerFitnessGoal(OWNER_ID, { ...command, goal: 'x' }), {
    ok: false,
    reason: 'invalid',
  });
  assert.deepEqual(getRelationshipMemory(OWNER_ID), []);
  assert.deepEqual(getRelationshipMemory(OTHER_ID), []);
});

test('saved owner goal and target weight survive a fresh process read', () => {
  const saved = saveOwnerFitnessGoal(OWNER_ID, {
    kind: 'save_fitness_goal',
    goal: 'да подобря издръжливостта си',
    targetWeightKg: '70',
  });
  assert.equal(saved.ok, true);

  const childScript = `
    const { getRelationshipMemory } = require(${JSON.stringify(require.resolve('../relationshipMemory'))});
    const facts = getRelationshipMemory(${JSON.stringify(OWNER_ID)});
    process.stdout.write(JSON.stringify(facts.map(({ category, value }) => ({ category, value }))));
  `;
  const child = spawnSync(process.execPath, ['-e', childScript], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      RELATIONSHIP_MEMORY_PATH: memoryPath,
    },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const restored = JSON.parse(child.stdout);
  assert.deepEqual(restored, [
    { category: 'goals', value: 'Основна фитнес цел: подобря издръжливостта си' },
    { category: 'goals', value: 'Целево тегло: 70 кг' },
  ]);

  const context = buildOwnerV22Context(OWNER_ID, {
    readProfile: () => null,
    readUserMemory: () => null,
  });
  const summary = formatOwnerPersonalMemory(context);
  assert.match(summary, /подобря издръжливостта си/);
  assert.match(summary, /Целево тегло: 70 кг \(изрично записано към цел\)/);
  assert.equal(
    (summary.match(/Целево тегло: 70 кг/g) || []).length,
    1,
    'the stored target should not also appear in the general goals list'
  );
});

test('fitness-goal recall wording is memory intent, not a health-log lookup', () => {
  for (const query of [
    'Ели, каква беше фитнес целта ми и до колко кг исках да стигна?',
    'Припомни ми основната фитнес цел и колко килограма исках да достигна.',
    'Колко кг искам да достигна?',
  ]) {
    assert.equal(isProfileQuery(query), true, query);
  }
  assert.equal(
    isProfileQuery('Запомни, че фитнес целта ми е да кача мускулна маса и целевото ми тегло е 75 кг.'),
    false,
    'save commands must not be reinterpreted as profile-recall questions'
  );
});

test('write errors throw so the caller cannot report a successful save', () => {
  const brokenPath = path.join(tempDir, 'missing-directory', 'relationship_memory.json');
  process.env.RELATIONSHIP_MEMORY_PATH = brokenPath;
  assert.throws(
    () =>
      saveOwnerFitnessGoal(OWNER_ID, {
        kind: 'save_fitness_goal',
        goal: 'кача мускулна маса',
        targetWeightKg: '75',
      }),
    /ENOENT/
  );
});
