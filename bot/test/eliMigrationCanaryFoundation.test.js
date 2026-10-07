const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapLegacyProfile,
  mapRelationshipMemories,
  mapHealthEvents,
  mapCheckins,
  mapReminders,
  mapShortContext,
} = require('../brain/migration/legacyMigrationMapper');
const { dryRunLegacyImport } = require('../brain/migration/dryRunImporter');
const { createChecksumManifest, verifyChecksumManifest } = require('../brain/migration/backupManifest');
const { createCanaryReadRouter, parseAllowlist } = require('../brain/migration/canaryReadRouter');

const fixtures = {
  users: {
    '500001': { firstName: 'Ана', weight: 60, goal: 'повече движение' },
    '500002': { firstName: 'Борис' },
  },
  userMemory: {
    '500001': {
      favoriteFoods: 'овес',
      conversation: Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) })),
    },
  },
  relationshipMemory: {
    '500001': { memories: [{ id: 'm1', category: 'goals', value: 'повече движение' }] },
  },
  dailyLogs: {
    '500001': { '2026-10-07': [{ category: 'water', amount: 2, unit: 'cups', at: '2026-10-07T10:00:00.000Z' }] },
  },
  checkins: {
    '500001': { '2026-10-07': { water: true, completedAt: '2026-10-07T18:00:00.000Z' } },
  },
  reminders: {
    '500001': [{ id: 'r1', title: 'Вода', time: '09:00', days: ['mon'] }],
  },
  conversationState: { '500001': 1791392400000 },
};

test('maps all legacy domains without mutating fixtures', () => {
  const before = JSON.stringify(fixtures);
  assert.equal(mapLegacyProfile('500001', fixtures.users['500001'], fixtures.userMemory['500001']).telegramUserId, '500001');
  assert.equal(mapRelationshipMemories('500001', fixtures.relationshipMemory['500001']).length, 1);
  assert.equal(mapHealthEvents('500001', fixtures.dailyLogs['500001']).length, 1);
  assert.equal(mapCheckins('500001', fixtures.checkins['500001']).length, 1);
  assert.equal(mapReminders('500001', fixtures.reminders['500001']).length, 1);
  assert.equal(mapShortContext('500001', fixtures.userMemory['500001'], fixtures.conversationState).messages.length, 10);
  assert.equal(JSON.stringify(fixtures), before);
});

test('dry-run importer never writes and reconciles by Telegram id', async () => {
  const report = await dryRunLegacyImport(fixtures);
  assert.equal(report.writeEnabled, false);
  assert.equal(report.counts.writes, 0);
  assert.equal(report.counts.users, 2);
  assert.equal(report.counts.profiles, 2);
  assert.equal(report.reconciliation.length, 2);
  await assert.rejects(() => dryRunLegacyImport(fixtures, { write: true }), /dry-run only/);
});

test('invalid profile data is reported rather than written', async () => {
  const broken = {
    ...fixtures,
    users: { '500003': { firstName: { bad: true } } },
  };
  const report = await dryRunLegacyImport(broken);
  assert.equal(report.counts.writes, 0);
});

test('checksum manifest detects changes', () => {
  const manifest = createChecksumManifest({ 'users.json': '{"a":1}', 'reminders.json': '{}' });
  assert.equal(verifyChecksumManifest(manifest, { 'users.json': '{"a":1}', 'reminders.json': '{}' }).ok, true);
  assert.equal(verifyChecksumManifest(manifest, { 'users.json': '{"a":2}', 'reminders.json': '{}' }).ok, false);
});

test('canary allowlist uses durable only on exact match and falls back on mismatch', async () => {
  const logs = [];
  const router = createCanaryReadRouter({
    allowlist: '500001',
    durableReader: async () => ({ goal: 'A' }),
    legacyReader: async (id) => (id === '500001' ? { goal: 'B' } : { goal: 'L' }),
    diagnostics: (row) => logs.push(row),
  });
  const mismatch = await router.read('500001');
  assert.equal(mismatch.source, 'legacy_fallback');
  assert.equal(logs[0].type, 'durable_mismatch');
  const normal = await router.read('500002');
  assert.equal(normal.source, 'legacy');
});

test('canary durable read succeeds only for allowlisted matching user', async () => {
  const router = createCanaryReadRouter({
    allowlist: ['500001'],
    durableReader: async () => ({ same: true }),
    legacyReader: async () => ({ same: true }),
  });
  assert.equal((await router.read('500001')).source, 'durable_canary');
  assert.equal(parseAllowlist('1, 2').has('2'), true);
});
