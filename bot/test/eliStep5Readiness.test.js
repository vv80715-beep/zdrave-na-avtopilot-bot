const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateStep5Readiness } = require('../brain/migration/readinessGate');
const { createChecksumManifest, verifyChecksumManifest } = require('../brain/migration/backupManifest');
const {
  validateProfile,
  validateUserMemory,
  validateRelationshipMemory,
  validateDailyLogs,
  validateCheckins,
  validateReminders,
  collectUserIssues,
} = require('../brain/migration/legacyValidators');

test('legacy validators accept representative valid records', () => {
  assert.deepEqual(validateProfile({ firstName: 'Ана', age: 30, weight: 60 }), []);
  assert.deepEqual(validateUserMemory({ conversation: [{ role: 'user', content: 'Здравей' }] }), []);
  assert.deepEqual(validateRelationshipMemory({ memories: [{ category: 'goals', value: 'движение' }] }), []);
  assert.deepEqual(validateDailyLogs({ '2026-10-07': [{ category: 'water', amount: 2 }] }), []);
  assert.deepEqual(validateCheckins({ '2026-10-07': { water: true } }), []);
  assert.deepEqual(validateReminders([{ id: 'r1', title: 'Вода', time: '09:00' }]), []);
});

test('legacy validators report malformed records', () => {
  assert.ok(validateProfile({ age: 'thirty' }).length > 0);
  assert.ok(validateUserMemory({ conversation: {} }).length > 0);
  assert.ok(validateRelationshipMemory({ memories: {} }).length > 0);
  assert.ok(validateDailyLogs({ '2026-10-07': {} }).length > 0);
  assert.ok(validateCheckins({ '2026-10-07': 'bad' }).length > 0);
  assert.ok(validateReminders([{ id: '', title: '', time: 9 }]).length > 0);

  const issues = collectUserIssues('bad-id', {
    users: { 'bad-id': { age: 'wrong' } },
  });
  assert.ok(issues.length >= 2);
});

test('readiness gate passes only a clean non-production dry-run', () => {
  const files = { 'users.json': '{"500001":{"firstName":"Ана"}}' };
  const manifest = createChecksumManifest(files);
  const checksumVerification = verifyChecksumManifest(manifest, files);

  const result = evaluateStep5Readiness({
    report: {
      mode: 'dry-run',
      writeEnabled: false,
      counts: { writes: 0, invalid: 0, conflicting: 0 },
      reconciliation: [{ telegramUserId: '500001' }],
    },
    checksumVerification,
  });

  assert.equal(result.status, 'non_production_validation_passed');
  assert.equal(result.productionActivationAuthorized, false);
  assert.equal(Object.values(result.checks).every(Boolean), true);
});

test('readiness gate blocks invalid or conflicting dry-run reports', () => {
  const result = evaluateStep5Readiness({
    report: {
      mode: 'dry-run',
      writeEnabled: false,
      counts: { writes: 0, invalid: 1, conflicting: 1 },
      reconciliation: [{ telegramUserId: '500001' }],
    },
    checksumVerification: { ok: true },
  });

  assert.equal(result.status, 'review_required');
  assert.equal(result.checks.noInvalidRecords, false);
  assert.equal(result.checks.noUnresolvedConflicts, false);
  assert.equal(result.productionActivationAuthorized, false);
});

test('readiness gate blocks any write-enabled report', () => {
  const result = evaluateStep5Readiness({
    report: {
      mode: 'dry-run',
      writeEnabled: true,
      counts: { writes: 1, invalid: 0, conflicting: 0 },
      reconciliation: [{ telegramUserId: '500001' }],
    },
    checksumVerification: { ok: true },
  });

  assert.equal(result.status, 'review_required');
  assert.equal(result.checks.dryRunOnly, false);
  assert.equal(result.checks.zeroWrites, false);
});
