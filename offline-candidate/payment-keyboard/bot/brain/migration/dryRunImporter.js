'use strict';

const { collectUserIssues } = require('./legacyValidators');

const {
  mapLegacyProfile,
  mapRelationshipMemories,
  mapUserMemoryFacts,
  mapHealthEvents,
  mapCheckins,
  mapReminders,
  mapShortContext,
} = require('./legacyMigrationMapper');

const SOURCE_NAMES = Object.freeze([
  'users',
  'userMemory',
  'relationshipMemory',
  'dailyLogs',
  'checkins',
  'reminders',
  'conversationState',
]);

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function allUserIds(sources) {
  const ids = new Set();
  for (const name of SOURCE_NAMES) {
    const source = objectOrEmpty(sources[name]);
    for (const id of Object.keys(source)) ids.add(String(id));
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function createEmptyCounts() {
  return {
    users: 0,
    profiles: 0,
    memoryFacts: 0,
    events: 0,
    checkins: 0,
    reminders: 0,
    shortContext: 0,
    skipped: 0,
    invalid: 0,
    conflicting: 0,
    writes: 0,
  };
}

async function dryRunLegacyImport(sources = {}, options = {}) {
  if (options.write === true) {
    throw new Error('Step 4 importer is dry-run only; writes are disabled.');
  }

  const counts = createEmptyCounts();
  const reconciliation = [];
  const diagnostics = [];
  const ids = allUserIds(sources);
  counts.users = ids.length;

  for (const id of ids) {
    const validationIssues = collectUserIssues(id, sources);
    if (validationIssues.length) {
      counts.invalid += validationIssues.length;
      diagnostics.push(...validationIssues.map((issue) => ({ telegramUserId: id, ...issue })));
    }

    const row = {
      telegramUserId: id,
      profiles: 0,
      memoryFacts: 0,
      events: 0,
      checkins: 0,
      reminders: 0,
      shortContext: 0,
      skipped: 0,
      invalid: 0,
      conflicting: 0,
    };

    row.invalid += validationIssues.length;

    try {
      const profile = mapLegacyProfile(
        id,
        objectOrEmpty(sources.users)[id] || {},
        objectOrEmpty(sources.userMemory)[id] || {}
      );
      if (profile) {
        row.profiles += 1;
        counts.profiles += 1;
      }
    } catch (error) {
      row.invalid += 1;
      counts.invalid += 1;
      diagnostics.push({ telegramUserId: id, source: 'profile', error: error.message });
    }

    const legacyMemory = objectOrEmpty(sources.userMemory)[id] || {};
    const relationship = objectOrEmpty(sources.relationshipMemory)[id] || {};
    const facts = [];
    try {
      facts.push(...mapUserMemoryFacts(id, legacyMemory));
      facts.push(...mapRelationshipMemories(id, relationship));
      const seen = new Map();
      for (const fact of facts) {
        const key = fact.category + ':' + (fact.key || '');
        if (seen.has(key) && seen.get(key) !== fact.value) {
          row.conflicting += 1;
          counts.conflicting += 1;
        } else {
          seen.set(key, fact.value);
        }
      }
      row.memoryFacts += facts.length;
      counts.memoryFacts += facts.length;
    } catch (error) {
      row.invalid += 1;
      counts.invalid += 1;
      diagnostics.push({ telegramUserId: id, source: 'memory', error: error.message });
    }

    const events = mapHealthEvents(id, objectOrEmpty(sources.dailyLogs)[id] || {});
    row.events += events.length;
    counts.events += events.length;

    const checkins = mapCheckins(id, objectOrEmpty(sources.checkins)[id] || {});
    row.checkins += checkins.length;
    counts.checkins += checkins.length;

    const reminders = mapReminders(id, objectOrEmpty(sources.reminders)[id] || []);
    row.reminders += reminders.length;
    counts.reminders += reminders.length;

    const context = mapShortContext(id, legacyMemory, objectOrEmpty(sources.conversationState));
    if (context.messages.length) {
      row.shortContext += 1;
      counts.shortContext += 1;
    } else {
      row.skipped += 1;
      counts.skipped += 1;
    }

    reconciliation.push(row);
  }

  return {
    mode: 'dry-run',
    writeEnabled: false,
    counts,
    reconciliation,
    diagnostics,
  };
}

module.exports = { dryRunLegacyImport, allUserIds };
