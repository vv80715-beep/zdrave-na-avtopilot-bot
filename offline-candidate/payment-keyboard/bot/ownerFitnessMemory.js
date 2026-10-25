'use strict';

const { isOwnerId } = require('./adminGuard');
const {
  getRelationshipMemory,
  saveRelationshipMemory,
  updateRelationshipMemory,
} = require('./relationshipMemory');

const GOAL_PREFIX = 'Основна фитнес цел: ';
const WEIGHT_PREFIX = 'Целево тегло: ';

const COMMAND_CUE =
  /(?:^|[^а-яa-z])(?:запомни(?:\s+ми)?|запиши(?:\s+ми)?|отбележи|съхрани|промени|обнови|актуализирай|смени|искам\s+да\s+(?:запомниш|запишеш|отбележиш|съхраниш|промениш|обновиш|смениш)|можеш\s+ли\s+да\s+(?:запомниш|запишеш|промениш|обновиш|смениш))(?![а-яa-z])/iu;
const FITNESS_GOAL_CUE =
  /(?:фитнес|спорт(?:на|ната)?|тренировъчн[а-я]*)\s+цел(?:та)?(?:\s+ми)?|цел(?:та)?\s+ми\s+за\s+(?:фитнес|спорт|тренировк[а-я]*)|(?:основната|главната)\s+ми\s+цел|целта\s+ми/iu;
const TARGET_WEIGHT_CUE =
  /(?:целев(?:о|ото)\s+(?:ми\s+)?тегло(?:то)?\s*(?:(?:е|на)\s*|да\s+бъде\s*)?|целта\s+ми\s+за\s+тегло\s*(?:(?:е|на)\s*|да\s+бъде\s*)?|искам\s+да\s+(?:достигна|стигна|тежа)(?:\s+до)?\s*|(?:да\s+)?(?:достигна|стигна)(?:\s+до)?\s*|до\s*)(\d{2,3}(?:[.,]\d+)?)\s*(?:кг|килограм(?:а|и|ов)?)(?![а-я])/iu;

function cleanGoal(value) {
  return String(value || '')
    .replace(/^\s*(?:е|:\s*|—\s*)/iu, '')
    .replace(/^\s*на\s+/iu, '')
    .replace(/^\s*(?:искам\s+)?да\s+/iu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:.—-]+|[\s,;:.—-]+$/g, '')
    .trim();
}

function parseTargetWeight(text) {
  const match = text.match(TARGET_WEIGHT_CUE);
  if (!match) return null;
  const numeric = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(numeric) || numeric < 30 || numeric > 300) return null;
  return Number.isInteger(numeric) ? String(numeric) : String(numeric);
}

function detectOwnerFitnessMemoryCommand(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const normalized = text.toLocaleLowerCase('bg').replace(/\s+/g, ' ').trim();
  if (!COMMAND_CUE.test(normalized) || !FITNESS_GOAL_CUE.test(normalized)) return null;

  const goalCue = FITNESS_GOAL_CUE.exec(normalized);
  const tail = normalized.slice(goalCue.index + goalCue[0].length);
  // Stop before the separately stated target weight so it is not folded into
  // the goal text. The target parser below requires explicit kg and target
  // language; a current-weight report alone is never enough.
  const targetStart = tail.search(
    /(?:целев(?:о|ото)\s+(?:ми\s+)?тегло(?:то)?\s*(?:(?:е|на)\s*|да\s+бъде\s*)?|целта\s+ми\s+за\s+тегло\s*(?:(?:е|на)\s*|да\s+бъде\s*)?|искам\s+да\s+(?:достигна|стигна|тежа)(?:\s+до)?\s*|(?:да\s+)?(?:достигна|стигна)(?:\s+до)?\s*|до\s*)\d{2,3}(?:[.,]\d+)?\s*(?:кг|килограм(?:а|и|ов)?)(?![а-я])/iu
  );
  const goalText = targetStart >= 0 ? tail.slice(0, targetStart) : tail;
  const goal = cleanGoal(goalText)
    .replace(/(?:,?\s*)(?:и\s+)?(?:целев(?:о|ото)\s+(?:ми\s+)?тегло|целта\s+ми\s+за\s+тегло).*$/iu, '')
    .replace(/(?:,?\s*)(?:и|а)\s+(?:искам\s+)?да\s+(?:достигна|стигна|тежа).*$/iu, '')
    .replace(/(?:,?\s*)до\s+\d{2,3}(?:[.,]\d+)?\s*(?:кг|килограм(?:а|и|ов)?).*$/iu, '')
    .replace(/\s+(?:и|а|като)$/iu, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,;:.—-]+$/g, '')
    .trim();
  const targetWeightKg = parseTargetWeight(normalized);

  return {
    kind: 'save_fitness_goal',
    goal: goal.length >= 3 && goal.length <= 180 ? goal : null,
    targetWeightKg,
  };
}

function upsertManagedFact(userId, prefix, value) {
  const existing = getRelationshipMemory(userId).find(
    (entry) =>
      entry.category === 'goals' &&
      typeof entry.value === 'string' &&
      entry.value.startsWith(prefix)
  );
  const storedValue = `${prefix}${value}`;
  if (existing) {
    return updateRelationshipMemory(userId, existing.id, storedValue);
  }
  return saveRelationshipMemory(userId, 'goals', storedValue);
}

function saveOwnerFitnessGoal(userId, command) {
  if (!isOwnerId(userId)) {
    return { ok: false, reason: 'unauthorized' };
  }
  if (
    !command ||
    command.kind !== 'save_fitness_goal' ||
    typeof command.goal !== 'string' ||
    command.goal.trim().length < 3 ||
    command.goal.trim().length > 180 ||
    typeof command.targetWeightKg !== 'string'
  ) {
    return { ok: false, reason: 'invalid' };
  }

  const goal = cleanGoal(command.goal);
  const targetWeight = Number(command.targetWeightKg);
  if (
    goal.length < 3 ||
    goal.length > 180 ||
    !Number.isFinite(targetWeight) ||
    targetWeight < 30 ||
    targetWeight > 300
  ) {
    return { ok: false, reason: 'invalid' };
  }

  const canonicalWeight = Number.isInteger(targetWeight)
    ? String(targetWeight)
    : String(targetWeight);
  upsertManagedFact(userId, GOAL_PREFIX, goal);
  upsertManagedFact(userId, WEIGHT_PREFIX, `${canonicalWeight} кг`);

  // A successful API return is not enough: only claim the save after loading
  // both exact, managed facts back from the persistent relationship store.
  const stored = getRelationshipMemory(userId);
  const goalValue = `${GOAL_PREFIX}${goal}`;
  const weightValue = `${WEIGHT_PREFIX}${canonicalWeight} кг`;
  const goalVerified = stored.some(
    (entry) => entry.category === 'goals' && entry.value === goalValue
  );
  const weightVerified = stored.some(
    (entry) => entry.category === 'goals' && entry.value === weightValue
  );

  if (!goalVerified || !weightVerified) {
    return { ok: false, reason: 'verification_failed' };
  }
  return { ok: true, goal, targetWeightKg: canonicalWeight };
}

module.exports = {
  detectOwnerFitnessMemoryCommand,
  saveOwnerFitnessGoal,
};
