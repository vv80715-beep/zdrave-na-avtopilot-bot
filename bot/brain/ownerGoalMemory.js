'use strict';

// Narrow, explicit owner memory actions. Do not enable passive capture or V2.2
// durable reads/writes. The personal facts live in existing local JSON storage.
const { isOwnerId } = require('../adminGuard');
const { getUser } = require('../storage');
const store = require('../relationshipMemoryStorage');
const { buildOwnerV22Context } = require('./ownerV22Context');
const { getKnownProfileEntries } = require('./unifiedHealthProfile');

const GOAL_PREFIX = 'Основна фитнес цел:';

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function detectOwnerGoalIntent(message) {
  const text = normalize(message);
  if (!text) return null;

  const aboutGoal = /фитнес\s+цел|основн(?:а|ата)\s+(?:ми\s+)?цел|целта\s+ми|мускулна\s+маса|целево\s+тегло|килограма\s+искам\s+да\s+достигна/.test(text);
  if (!aboutGoal) return null;

  const wantsSave = /(?:искам\s+да\s+(?:си\s+)?запомниш|запомни|запиши|запази|искам\s+да\s+запишеш)/.test(text);
  if (wantsSave) {
    const muscle = /мускулна\s+маса|(?:кач|покач|натруп).{0,35}мускул/.test(text);
    const weightLoss = /отслаб|свал.{0,30}(?:кг|килограм|тегло)/.test(text);
    if (!muscle && !weightLoss) return { type: 'unsupported_goal_save' };

    const targetMatch = text.match(/(?:достигн(?:а|е|ем)|целево\s+тегло|до)\s*(\d{2,3}(?:[.,]\d)?)\s*(?:кг|килограма)/);
    const targetWeightKg = targetMatch ? Number(targetMatch[1].replace(',', '.')) : null;
    if (targetMatch && (!Number.isFinite(targetWeightKg) || targetWeightKg < 30 || targetWeightKg > 350)) {
      return { type: 'unsupported_goal_save' };
    }
    return {
      type: 'save_goal',
      goal: muscle ? 'качване на мускулна маса' : 'отслабване',
      targetWeightKg,
    };
  }

  const wantsRecall = /какво\s+(?:си\s+)?(?:помниш|знаеш)|помниш\s+ли|каква\s+е\s+(?:основната|моята)|колко\s+килограма\s+искам\s+да\s+достигна|кажи\s+ми\s+(?:моята|основната)\s+цел/.test(text);
  return wantsRecall ? { type: 'recall_goal' } : null;
}

function isOwnerGoalMemoryIntent(message) {
  return detectOwnerGoalIntent(message) !== null;
}

function storedGoal(userId) {
  const memories = store.getUserMemories(userId);
  return [...memories].reverse().find(
    (row) => row.category === 'goals' && String(row.value || '').startsWith(GOAL_PREFIX)
  ) || null;
}

function recallGoal(userId) {
  const saved = storedGoal(userId);
  if (saved) return `Помня от записаната ти памет: ${saved.value}`;
  const profileGoal = getUser(userId)?.goal;
  if (typeof profileGoal === 'string' && profileGoal.trim()) {
    return `В профила ти е записана цел: ${profileGoal.trim()}. Нямам потвърдено целево тегло в паметта за фитнес целта.`;
  }
  return 'Все още нямам записана основна фитнес цел или целево тегло в личната ти памет.';
}

function saveGoal(userId, intent) {
  const value = `${GOAL_PREFIX} ${intent.goal}${intent.targetWeightKg === null ? '' : `; целево тегло: ${intent.targetWeightKg} кг`}`;
  try {
    const existing = storedGoal(userId);
    if (!existing || existing.value !== value) {
      if (existing) store.updateMemory(userId, existing.id, value);
      else store.addMemory(userId, 'goals', value);
    }

    // Verify the persisted data after the write; never confirm from the input alone.
    const persisted = storedGoal(userId);
    if (!persisted || persisted.value !== value) {
      return 'Не успях да потвърдя записа на фитнес целта. Опитай отново по-късно.';
    }
    return `Записах успешно в личната ти памет: ${value}`;
  } catch (err) {
    console.error('Owner goal memory save failed:', err.message);
    return 'Не успях да запиша фитнес целта в паметта. Опитай отново по-късно.';
  }
}

// null means "not a supported owner request"; the caller follows legacy routing.
function handleOwnerGoalMemory(userId, message) {
  if (!isOwnerId(userId)) return null;
  const intent = detectOwnerGoalIntent(message);
  if (!intent) return null;
  if (intent.type === 'recall_goal') return recallGoal(userId);
  if (intent.type === 'save_goal') return saveGoal(userId, intent);
  return 'Кажи ми конкретната си фитнес цел, например „Запомни, че основната ми фитнес цел е да кача мускулна маса и да достигна 65 кг“.';
}

// Show only actually persisted facts. Never echo OWNER_MEMORY or system prompts.
function formatOwnerStoredSummary(userId) {
  if (!isOwnerId(userId)) return 'Нямаш достъп до тази информация.';
  const { profile, longTermFacts } = buildOwnerV22Context(userId);
  const lines = ['Лична памет за собственика (само записани данни):'];
  for (const entry of getKnownProfileEntries(profile)) {
    if (typeof entry.value === 'string' || typeof entry.value === 'number') {
      lines.push(`- ${entry.label}: ${entry.value}`);
    }
  }
  for (const fact of longTermFacts) {
    const value = fact?.value;
    if (typeof value === 'string' && value.trim()) lines.push(`- ${value.trim()}`);
    else if (typeof value === 'number' && Number.isFinite(value)) lines.push(`- ${value}`);
  }
  if (lines.length === 1) return 'Нямам записани лични факти за теб в текущата памет.';
  return lines.join('\n');
}

module.exports = {
  detectOwnerGoalIntent,
  isOwnerGoalMemoryIntent,
  handleOwnerGoalMemory,
  formatOwnerStoredSummary,
};
