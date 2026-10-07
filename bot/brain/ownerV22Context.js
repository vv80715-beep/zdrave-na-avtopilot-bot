'use strict';

const { getUser } = require('../storage');
const { getMemory } = require('../memoryStorage');
const { getUserMemories } = require('../relationshipMemoryStorage');
const {
  mapLegacyProfile,
  mapRelationshipMemories,
  mapUserMemoryFacts,
} = require('./migration/legacyMigrationMapper');
const { getKnownProfileEntries } = require('./unifiedHealthProfile');

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function usefulValue(value) {
  if (nonEmptyString(value)) return value;
  if (Array.isArray(value)) {
    const items = value.filter((item) => nonEmptyString(item));
    return items.length ? items : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function sanitizeProfile(raw = {}) {
  const profile = {};
  const strings = [
    'firstName',
    'gender',
    'goal',
    'activityLevel',
    'trainingExperience',
    'foodPreferences',
    'medicalNotes',
  ];
  for (const key of strings) {
    const value = nonEmptyString(raw[key]);
    if (value) profile[key] = value;
  }
  for (const key of ['age', 'height', 'weight']) {
    const value = finiteNumber(raw[key]);
    if (value !== null) profile[key] = value;
  }
  return profile;
}

function sanitizeMemory(raw = {}) {
  const memory = {};
  for (const key of [
    'injuries',
    'allergies',
    'favoriteFoods',
    'dislikedFoods',
    'dailyHabits',
    'motivationLevel',
    'lastWorkout',
  ]) {
    const value = usefulValue(raw[key]);
    if (value !== null) memory[key] = value;
  }
  if (nonEmptyString(raw.updatedAt)) memory.updatedAt = raw.updatedAt;
  return memory;
}

function sanitizeRelationshipMemories(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && nonEmptyString(row.value))
    .map((row) => ({
      id: row.id == null ? null : String(row.id),
      category: nonEmptyString(row.category) || 'general',
      value: nonEmptyString(row.value),
      createdAt: nonEmptyString(row.createdAt),
      updatedAt: nonEmptyString(row.updatedAt),
    }));
}

function normalizeComparable(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim().toLowerCase()).join('|');
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildOwnerV22Context(userId, dependencies = {}) {
  const id = String(userId);
  const getUserFn = dependencies.getUser || getUser;
  const getMemoryFn = dependencies.getMemory || getMemory;
  const getUserMemoriesFn = dependencies.getUserMemories || getUserMemories;

  const legacyProfile = sanitizeProfile(getUserFn(id) || {});
  const legacyMemory = sanitizeMemory(getMemoryFn(id) || {});
  const relationshipRows = sanitizeRelationshipMemories(getUserMemoriesFn(id));

  const profileRecord = mapLegacyProfile(id, legacyProfile, legacyMemory);
  const profile = profileRecord.profile;
  const profileValues = new Set(
    getKnownProfileEntries(profile)
      .map((entry) => normalizeComparable(entry.value))
      .filter(Boolean)
  );

  const facts = [
    ...mapUserMemoryFacts(id, legacyMemory),
    ...mapRelationshipMemories(id, { memories: relationshipRows }),
  ];

  const seen = new Set();
  const longTermFacts = facts.filter((fact) => {
    const valueKey = normalizeComparable(fact.value);
    if (!valueKey || profileValues.has(valueKey)) return false;
    const key = [
      fact.category || '',
      fact.key || '',
      valueKey,
    ].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { profile, longTermFacts };
}

module.exports = {
  buildOwnerV22Context,
  sanitizeProfile,
  sanitizeMemory,
  sanitizeRelationshipMemories,
};
