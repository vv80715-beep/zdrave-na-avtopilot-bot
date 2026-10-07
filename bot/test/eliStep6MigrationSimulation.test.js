const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalSourceFiles,
  runStep6MigrationSimulation,
} = require('../brain/migration/testMigrationSimulation');
const { createChecksumManifest } = require('../brain/migration/backupManifest');

function fixtures() {
  return {
    users: {
      '600001': { firstName: 'Ана', age: 30, weight: 60, goal: 'повече движение' },
      '600002': { firstName: 'Борис', age: 28 },
    },
    userMemory: {
      '600001': {
        favoriteFoods: 'овес',
        updatedAt: '2026-10-07T12:00:00.000Z',
        conversation: [
          { role: 'user', content: 'Предпочитам кратки отговори.' },
          { role: 'assistant', content: 'Разбрах.' },
        ],
      },
    },
    relationshipMemory: {
      '600001': {
        memories: [{ id: 'm1', category: 'goals', value: 'повече движение' }],
      },
    },
    dailyLogs: {
      '600001': {
        '2026-10-07': [
          { category: 'water', amount: 2, unit: 'cups', at: '2026-10-07T10:00:00.000Z' },
        ],
      },
    },
    checkins: {
      '600001': {
        '2026-10-07': { water: true, completedAt: '2026-10-07T18:00:00.000Z' },
      },
    },
    reminders: {
      '600001': [{ id: 'r1', title: 'Вода', time: '09:00', days: ['mon'] }],
    },
    conversationState: {
      '600001': 1791392400000,
    },
  };
}

test('clean fixture simulation reconciles with zero external writes', async () => {
  const report = await runStep6MigrationSimulation(fixtures());

  assert.equal(report.status, 'non_production_foundation_complete');
  assert.equal(report.externalWrites, 0);
  assert.equal(report.productionActivationAuthorized, false);
  assert.equal(report.reconciliation.ok, true);
  assert.equal(report.simulation.validationIssues.length, 0);
});

test('stale checksum blocks before simulation', async () => {
  const source = fixtures();
  const files = canonicalSourceFiles(source);
  const manifest = createChecksumManifest(files);
  files['users.json'] = files['users.json'].replace('Ана', 'Променена');

  const report = await runStep6MigrationSimulation(source, {
    sourceFiles: files,
    manifest,
  });

  assert.equal(report.status, 'blocked_before_simulation');
  assert.equal(report.checksumVerification.ok, false);
  assert.equal(report.simulation, null);
  assert.equal(report.externalWrites, 0);
});

test('invalid legacy data blocks before simulation', async () => {
  const source = fixtures();
  source.users['600001'].age = 'thirty';

  const report = await runStep6MigrationSimulation(source);

  assert.equal(report.status, 'blocked_before_simulation');
  assert.ok(report.dryRun.counts.invalid > 0);
  assert.equal(report.productionActivationAuthorized, false);
});

test('missing short context expiry is surfaced during simulation', async () => {
  const source = fixtures();
  delete source.conversationState['600001'];
  delete source.userMemory['600001'].updatedAt;

  const report = await runStep6MigrationSimulation(source);

  assert.equal(report.status, 'review_required');
  assert.ok(
    report.simulation.validationIssues.some(
      (issue) => issue.code === 'short_context_missing_expiry'
    )
  );
});
