'use strict';

const { getUser } = require('../storage');
const { getMemory } = require('../memoryStorage');
const { getUserMemories } = require('../relationshipMemoryStorage');
const {
  mapLegacyProfile,
  mapUserMemoryFacts,
  mapRelationshipMemories,
} = require('./migration/legacyMigrationMapper');
const { getKnownProfileEntries } = require('./unifiedHealthProfile');

const LEGACY_PROFILE_FIELDS = Object.freeze([
  'firstName',
  'age',
  'gender',
  'height',
  'weight',
  'goal',
  'activityLevel',
  'trainingExperience',
  'foodPreferences',
  'medicalNotes',
]);

const LEGACY_MEMORY_FIELDS = Object.freeze([
  'injuries',
  'allergies',
  'favoriteFoods',
  'dislikedFoods',
  'dailyHabits',
  'motivationLevel',
]);

const PROFILE_BACKED_MEMORY_FACTS = new Set([
  'dislikedFoods',
  'dailyHabits',
  'lastWorkout',
]);

function isPlainRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeStoredValue(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const values = value
      .filter((item) => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)))
      .map((item) => String(item).trim())
      .filter(Boolean);
    return values.length ? values : null;
  }
  return null;
}

function normalizeLastWorkout(value) {
  const normalized = normalizeStoredValue(value);
  if (normalized !== null) return normalized;
  if (!isPlainRecord(value)) return null;

  const date = normalizeStoredValue(value.date);
  const note = normalizeStoredValue(value.note);
  const parts = [date, note]
    .flatMap((part) => Array.isArray(part) ? part : [part])
    .filter((part) => part !== null && part !== undefined && String(part).trim());
  return parts.length ? parts.join(' — ') : null;
}

function normalizeLegacyProfile(value) {
  const source = isPlainRecord(value) ? value : {};
  const profile = {};
  for (const field of LEGACY_PROFILE_FIELDS) {
    const normalized = normalizeStoredValue(source[field]);
    if (normalized !== null) profile[field] = normalized;
  }
  return profile;
}

function normalizeLegacyMemory(value) {
  const source = isPlainRecord(value) ? value : {};
  const memory = {};
  for (const field of LEGACY_MEMORY_FIELDS) {
    const normalized = normalizeStoredValue(source[field]);
    if (normalized !== null) memory[field] = normalized;
  }
  const lastWorkout = normalizeLastWorkout(source.lastWorkout);
  if (lastWorkout !== null) memory.lastWorkout = lastWorkout;
  const updatedAt = normalizeStoredValue(source.updatedAt);
  if (typeof updatedAt === 'string') memory.updatedAt = updatedAt;
  return memory;
}

function normalizeRelationshipMemories(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((memory) => isPlainRecord(memory))
    .map((memory) => ({
      id: normalizeStoredValue(memory.id),
      category: normalizeStoredValue(memory.category),
      value: normalizeStoredValue(memory.value),
      createdAt: normalizeStoredValue(memory.createdAt),
      updatedAt: normalizeStoredValue(memory.updatedAt),
    }))
    .filter((memory) => memory.value !== null);
}

function comparableValue(value) {
  const normalized = Array.isArray(value) ? value.join(', ') : value;
  return String(normalized ?? '').trim().toLocaleLowerCase();
}

// Read-only bridge from the existing per-user JSON stores. It deliberately
// does not read health logs/check-ins or use the durable repository/Supabase.
function buildOwnerV22Context(userId, readers = {}) {
  const id = String(userId ?? '').trim();
  if (!id) throw new TypeError('userId is required');

  const readProfile = readers.readProfile || getUser;
  const readUserMemory = readers.readUserMemory || getMemory;
  const readRelationshipMemories = readers.readRelationshipMemories || getUserMemories;

  const legacyProfile = normalizeLegacyProfile(readProfile(id));
  const legacyMemory = normalizeLegacyMemory(readUserMemory(id));
  const relationshipMemories = normalizeRelationshipMemories(readRelationshipMemories(id));

  const profile = mapLegacyProfile(id, legacyProfile, legacyMemory).profile;
  const knownProfileValues = new Set(
    getKnownProfileEntries(profile).map((entry) => comparableValue(entry.value))
  );

  const candidates = [
    ...mapUserMemoryFacts(id, legacyMemory)
      .filter((fact) => !PROFILE_BACKED_MEMORY_FACTS.has(fact.key)),
    ...mapRelationshipMemories(id, { memories: relationshipMemories }),
  ];
  const seen = new Set();
  const longTermFacts = candidates.filter((fact) => {
    const value = comparableValue(fact.value);
    if (!value || knownProfileValues.has(value)) return false;
    const key = `${fact.category}\u0000${fact.key || ''}\u0000${value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { profile, longTermFacts };
}

module.exports = {
  buildOwnerV22Context,
  normalizeLastWorkout,
};
