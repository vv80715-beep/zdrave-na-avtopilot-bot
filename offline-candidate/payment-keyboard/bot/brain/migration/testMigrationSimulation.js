'use strict';

const { dryRunLegacyImport, allUserIds } = require('./dryRunImporter');
const { createChecksumManifest, verifyChecksumManifest } = require('./backupManifest');
const { evaluateStep5Readiness } = require('./readinessGate');
const {
  mapLegacyProfile,
  mapRelationshipMemories,
  mapUserMemoryFacts,
  mapHealthEvents,
  mapCheckins,
  mapReminders,
  mapShortContext,
} = require('./legacyMigrationMapper');

const COLLECTIONS = Object.freeze([
  'profiles',
  'memoryFacts',
  'events',
  'checkins',
  'reminders',
  'shortContext',
]);

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function canonicalSourceFiles(sources = {}) {
  return {
    'users.json': JSON.stringify(sources.users || {}, null, 2),
    'user_memory.json': JSON.stringify(sources.userMemory || {}, null, 2),
    'relationship_memory.json': JSON.stringify(sources.relationshipMemory || {}, null, 2),
    'daily_logs.json': JSON.stringify(sources.dailyLogs || {}, null, 2),
    'daily_progress.json': JSON.stringify(sources.checkins || {}, null, 2),
    'reminders.json': JSON.stringify(sources.reminders || {}, null, 2),
    'conversation_state.json': JSON.stringify(sources.conversationState || {}, null, 2),
  };
}

function mapUserToDurableContracts(userId, sources = {}) {
  const userMemory = record(sources.userMemory)[userId] || {};
  const shortContext = mapShortContext(
    userId,
    userMemory,
    record(sources.conversationState)
  );

  return {
    profiles: [
      mapLegacyProfile(
        userId,
        record(sources.users)[userId] || {},
        userMemory
      ),
    ],
    memoryFacts: [
      ...mapUserMemoryFacts(userId, userMemory),
      ...mapRelationshipMemories(
        userId,
        record(sources.relationshipMemory)[userId] || {}
      ),
    ],
    events: mapHealthEvents(
      userId,
      record(sources.dailyLogs)[userId] || {}
    ),
    checkins: mapCheckins(
      userId,
      record(sources.checkins)[userId] || {}
    ),
    reminders: mapReminders(
      userId,
      record(sources.reminders)[userId] || []
    ),
    shortContext: shortContext.messages.length ? [shortContext] : [],
  };
}

function simulateDestination(sources = {}) {
  const users = {};
  const validationIssues = [];
  const totals = Object.fromEntries(COLLECTIONS.map((name) => [name, 0]));

  for (const userId of allUserIds(sources)) {
    const mapped = mapUserToDurableContracts(userId, sources);
    users[userId] = mapped;

    for (const collection of COLLECTIONS) {
      totals[collection] += mapped[collection].length;
      for (const row of mapped[collection]) {
        if (String(row.telegramUserId) !== String(userId)) {
          validationIssues.push({
            telegramUserId: String(userId),
            collection,
            code: 'user_isolation_mismatch',
          });
        }
      }
    }

    for (const context of mapped.shortContext) {
      if (context.messages.length > 10) {
        validationIssues.push({
          telegramUserId: String(userId),
          collection: 'shortContext',
          code: 'short_context_over_limit',
        });
      }
      if (!context.expiresAt) {
        validationIssues.push({
          telegramUserId: String(userId),
          collection: 'shortContext',
          code: 'short_context_missing_expiry',
        });
      }
    }
  }

  return {
    storage: 'fixture_memory_only',
    externalWrites: 0,
    totals,
    users,
    validationIssues,
  };
}

function reconcileDryRun(dryRun, simulation) {
  const mismatches = [];

  for (const expected of dryRun.reconciliation || []) {
    const userId = String(expected.telegramUserId);
    const actual = simulation.users[userId];
    if (!actual) {
      mismatches.push({
        telegramUserId: userId,
        collection: 'user',
        expected: 'present',
        actual: 'missing',
      });
      continue;
    }

    for (const collection of COLLECTIONS) {
      const expectedCount = Number(expected[collection] || 0);
      const actualCount = actual[collection].length;
      if (expectedCount !== actualCount) {
        mismatches.push({
          telegramUserId: userId,
          collection,
          expected: expectedCount,
          actual: actualCount,
        });
      }
    }
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
  };
}

async function runStep6MigrationSimulation(sources = {}, options = {}) {
  const files = options.sourceFiles || canonicalSourceFiles(sources);
  const manifest = options.manifest || createChecksumManifest(files);
  const checksumVerification = verifyChecksumManifest(manifest, files);
  const dryRun = await dryRunLegacyImport(sources);
  const step5 = evaluateStep5Readiness({
    report: dryRun,
    checksumVerification,
  });

  if (step5.status !== 'non_production_validation_passed') {
    return {
      step: 'Eli V2.2 Step 6',
      mode: 'fixture_simulation',
      status: 'blocked_before_simulation',
      externalWrites: 0,
      productionActivationAuthorized: false,
      manifest,
      checksumVerification,
      dryRun,
      step5,
      simulation: null,
      reconciliation: null,
    };
  }

  const simulation = simulateDestination(sources);
  const reconciliation = reconcileDryRun(dryRun, simulation);
  const clean =
    simulation.externalWrites === 0 &&
    simulation.validationIssues.length === 0 &&
    reconciliation.ok;

  return {
    step: 'Eli V2.2 Step 6',
    mode: 'fixture_simulation',
    status: clean
      ? 'non_production_foundation_complete'
      : 'review_required',
    externalWrites: 0,
    productionActivationAuthorized: false,
    manifest,
    checksumVerification,
    dryRun,
    step5,
    simulation,
    reconciliation,
  };
}

module.exports = {
  COLLECTIONS,
  canonicalSourceFiles,
  mapUserToDurableContracts,
  simulateDestination,
  reconcileDryRun,
  runStep6MigrationSimulation,
};
