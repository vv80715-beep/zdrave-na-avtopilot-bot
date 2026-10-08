'use strict';

const { getKnownProfileEntries } = require('./unifiedHealthProfile');

const GOAL_PROFILE_PATHS = new Set(['goals.primary', 'goals.supporting']);

const FACT_CATEGORY_LABELS = Object.freeze({
  health_context: 'Здравен контекст',
  nutrition: 'Хранителен факт',
  habits: 'Навик',
  motivation: 'Мотивация',
  activity: 'Активност',
  goals: 'Записана цел',
  communication_preferences: 'Предпочитание за общуване',
  personal_preferences: 'Лично предпочитание',
  recurring_challenges: 'Повтаряща се трудност',
  follow_up_topics: 'Тема за връщане',
  meaningful_progress: 'Значим напредък',
  relationship_context: 'Личен контекст',
});

function displayValue(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .filter((item) =>
        typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item))
      )
      .map((item) => String(item).trim())
      .filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

function targetWeightFromGoal(value) {
  const text = displayValue(value);
  if (!text) return null;

  // Only accept an explicitly framed target in a stored goal. Current body
  // weight is deliberately not considered here.
  const match = text.match(
    /(?:целев(?:о|ото)\s+тегло|теглото\s+ми|искам\s+да\s+(?:достигна|тежа)|достигна|до)\s*[:\-]?\s*(\d{2,3}(?:[.,]\d+)?)\s*(?:кг|килограм(?:а|и|ов)?)(?![а-я])/iu
  );
  return match ? `${match[1].replace(',', '.')} кг` : null;
}

function formatOwnerPersonalMemory(context = {}) {
  const profile = context.profile || {};
  const knownProfile = getKnownProfileEntries(profile);
  const facts = Array.isArray(context.longTermFacts) ? context.longTermFacts : [];
  const primaryGoal = knownProfile.find((entry) => entry.path === 'goals.primary');
  const supportingGoals = knownProfile.filter((entry) => entry.path === 'goals.supporting');
  const profileGoalValues = knownProfile
    .filter((entry) => GOAL_PROFILE_PATHS.has(entry.path))
    .map((entry) => displayValue(entry.value))
    .filter(Boolean);
  const storedGoalFacts = facts
    .filter((fact) => fact && fact.category === 'goals')
    .map((fact) => displayValue(fact.value))
    .filter(Boolean);
  const goalValues = [...new Set([...profileGoalValues, ...storedGoalFacts])];

  const targetWeights = [...new Set(
    [...profileGoalValues, ...storedGoalFacts]
      .map(targetWeightFromGoal)
      .filter(Boolean)
  )];
  const lines = ['🧠 Запазени лични факти от постоянната памет'];

  if (primaryGoal) {
    lines.push(`Основна цел: ${displayValue(primaryGoal.value)}`);
  } else if (goalValues.length) {
    lines.push(`Записани цели: ${goalValues.join('; ')}`);
  } else {
    lines.push('Основна цел: няма записана потвърдена цел.');
  }

  if (supportingGoals.length) {
    lines.push(
      `Допълнителни цели: ${supportingGoals.map((entry) => displayValue(entry.value)).filter(Boolean).join('; ')}`
    );
  }

  if (primaryGoal) {
    const otherGoalFacts = [...new Set(
      [...storedGoalFacts, ...profileGoalValues]
        .filter((value) => value !== displayValue(primaryGoal.value))
    )];
    if (otherGoalFacts.length) lines.push(`Други записани цели: ${otherGoalFacts.join('; ')}`);
  }

  if (targetWeights.length === 1) {
    lines.push(`Целево тегло: ${targetWeights[0]} (изрично записано към цел).`);
  } else if (targetWeights.length > 1) {
    lines.push(`Целево тегло: записани са няколко стойности — ${targetWeights.join('; ')}.`);
  } else {
    lines.push('Целево тегло: не е записано в постоянната памет.');
  }

  const otherProfileEntries = knownProfile.filter((entry) => !GOAL_PROFILE_PATHS.has(entry.path));
  for (const entry of otherProfileEntries) {
    const value = displayValue(entry.value);
    if (value) lines.push(`${entry.label}: ${value}`);
  }

  const otherFacts = facts
    .filter((fact) => fact && fact.category !== 'goals')
    .map((fact) => {
      const value = displayValue(fact.value);
      if (!value) return null;
      const label = FACT_CATEGORY_LABELS[fact.category] || 'Друг записан факт';
      return `${label}: ${value}`;
    })
    .filter(Boolean);
  lines.push(...new Set(otherFacts));

  if (!knownProfile.length && !facts.some((fact) => displayValue(fact && fact.value))) {
    lines.push('Все още няма други потвърдени лични факти в постоянната памет.');
  }

  return lines.join('\n');
}

module.exports = { formatOwnerPersonalMemory, targetWeightFromGoal };
