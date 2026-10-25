'use strict';

const {
  createUnknownHealthProfile,
  knownField,
} = require('../unifiedHealthProfile');
const {
  profileRecord,
  memoryFact,
  healthEvent,
  shortContextRecord,
} = require('../durableMemoryContracts');

function nonEmpty(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function setKnown(profile, path, value, source = 'legacy_json') {
  if (!nonEmpty(value)) return;
  const parts = path.split('.');
  let target = profile;
  for (let i = 0; i < parts.length - 1; i += 1) target = target[parts[i]];
  target[parts[parts.length - 1]] = knownField(value, { source, updatedAt: null });
}

function mapLegacyProfile(telegramUserId, legacyProfile = {}, legacyMemory = {}) {
  const profile = createUnknownHealthProfile(telegramUserId);
  setKnown(profile, 'identity.firstName', legacyProfile.firstName);
  setKnown(profile, 'identity.age', legacyProfile.age);
  setKnown(profile, 'identity.gender', legacyProfile.gender);
  setKnown(profile, 'identity.heightCm', legacyProfile.height);
  setKnown(profile, 'identity.weightKg', legacyProfile.weight);
  setKnown(profile, 'goals.primary', legacyProfile.goal);
  setKnown(profile, 'activity.level', legacyProfile.activityLevel);
  setKnown(profile, 'activity.trainingExperience', legacyProfile.trainingExperience);
  setKnown(profile, 'nutrition.preferences', legacyProfile.foodPreferences);
  setKnown(profile, 'nutrition.allergies', legacyMemory.allergies);
  setKnown(profile, 'nutrition.dislikedFoods', legacyMemory.dislikedFoods);
  setKnown(profile, 'habits.focus', legacyMemory.dailyHabits);
  setKnown(profile, 'progress.highlights', legacyMemory.lastWorkout);
  setKnown(profile, 'medical.userProvidedNotes', legacyProfile.medicalNotes);
  return profileRecord({ telegramUserId, profile, version: 1 });
}

function mapRelationshipMemories(telegramUserId, entry = {}) {
  const rows = Array.isArray(entry.memories) ? entry.memories : [];
  return rows
    .filter((m) => m && nonEmpty(m.value))
    .map((m) =>
      memoryFact({
        telegramUserId,
        category: m.category || 'general',
        key: m.id || null,
        value: m.value,
        source: 'relationship_memory.json',
        createdAt: m.createdAt || null,
        updatedAt: m.updatedAt || null,
      })
    );
}

function mapUserMemoryFacts(telegramUserId, memory = {}) {
  const fields = [
    ['injuries', 'health_context'],
    ['favoriteFoods', 'nutrition'],
    ['dislikedFoods', 'nutrition'],
    ['dailyHabits', 'habits'],
    ['motivationLevel', 'motivation'],
    ['lastWorkout', 'activity'],
  ];
  const facts = [];
  for (const [key, category] of fields) {
    if (!nonEmpty(memory[key])) continue;
    facts.push(memoryFact({
      telegramUserId,
      category,
      key,
      value: typeof memory[key] === 'string' ? memory[key] : JSON.stringify(memory[key]),
      source: 'user_memory.json',
      updatedAt: memory.updatedAt || null,
    }));
  }
  return facts;
}

function mapHealthEvents(telegramUserId, days = {}) {
  const events = [];
  for (const entries of Object.values(days || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || !entry.category) continue;
      events.push(
        healthEvent({
          telegramUserId,
          type: entry.category,
          value: entry.amount != null ? entry.amount : entry.value,
          unit: entry.unit || null,
          occurredAt: entry.at || null,
          metadata: {
            date: entry.date || null,
            time: entry.time || null,
            mealType: entry.mealType || null,
            raw: entry.raw || null,
          },
        })
      );
    }
  }
  return events;
}

function mapCheckins(telegramUserId, days = {}) {
  return Object.entries(days || {})
    .filter(([, value]) => value && typeof value === 'object')
    .map(([date, value]) => ({
      telegramUserId: String(telegramUserId),
      date,
      payload: { ...value },
      occurredAt: value.completedAt || null,
    }));
}

function mapReminders(telegramUserId, reminders = []) {
  return (Array.isArray(reminders) ? reminders : [])
    .filter((r) => r && r.id && r.title && r.time)
    .map((r) => ({
      telegramUserId: String(telegramUserId),
      legacyId: r.id,
      payload: {
        title: r.title,
        time: r.time,
        days: r.days || [],
        category: r.category || null,
        paused: Boolean(r.paused),
        lastSent: r.lastSent || null,
      },
      createdAt: r.createdAt || null,
      updatedAt: r.updatedAt || null,
    }));
}

function mapShortContext(telegramUserId, memory = {}, conversationState = {}) {
  const messages = Array.isArray(memory.conversation) ? memory.conversation : [];
  const lastSeen = conversationState[String(telegramUserId)] || null;
  const expiresAt = lastSeen ? new Date(Number(lastSeen) + 24 * 60 * 60 * 1000).toISOString() : null;
  return shortContextRecord({
    telegramUserId,
    messages: messages.slice(-10).map(({ role, content }) => ({ role, content })),
    expiresAt,
    updatedAt: memory.updatedAt || null,
  });
}

module.exports = {
  mapLegacyProfile,
  mapRelationshipMemories,
  mapUserMemoryFacts,
  mapHealthEvents,
  mapCheckins,
  mapReminders,
  mapShortContext,
};
