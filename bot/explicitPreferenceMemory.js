'use strict';

const {
  getRelationshipMemory,
  saveRelationshipMemory,
  updateRelationshipMemory,
} = require('./relationshipMemory');

const EXPLICIT_MEMORY_CUE =
  /(?:^|[^а-яa-z])(?:искам\s+да\s+(?:запомниш|запишеш|съхраниш|отбележиш|добавиш)|можеш\s+ли\s+да\s+(?:запомниш|запишеш|съхраниш)|запомни(?:\s+ми)?|запиши(?:\s+ми)?|съхрани|отбележи|добави)(?![а-яa-z])/iu;
const PREFERENCE_CUE =
  /(?:предпочитам|предпочитани(?:е|я|ята)?(?:\s+ми)?|харесвам|обичам|любима(?:та)?\s+ми|любимите\s+ми)/iu;
const WORKOUT_CUE =
  /(трени|трениров|лост|калистен|собствено тегло|фитнес|спорт|упражнен|плув|бяган|тичам|йога|танц|кросфит|пилат|силов)/iu;
const FOOD_CUE =
  /(хран|храна|храни|ям\b|яде\b|овес|лещ|боб|риба|месо|пилешк|яйц|плод|зеленч|млечн|ориз|кисело мляко)/iu;
const HABIT_CUE =
  /(навик|обикновено|редовно|ежедневно|всеки ден|всяка (?:сутрин|вечер|седмица))/iu;
const REPLACE_CUE =
  /(вече|всъщност|вместо това|отсега нататък|поправка|промени|обнови|актуализирай|смени|редактирай)/iu;

const DIMENSIONS = Object.freeze({
  workout: { category: 'personal_preferences', prefix: 'Предпочитан вид тренировка: ' },
  food: { category: 'personal_preferences', prefix: 'Хранително предпочитание: ' },
  habit: { category: 'habits', prefix: 'Устойчив навик: ' },
  personal: { category: 'personal_preferences', prefix: 'Лично предпочитание: ' },
});

function normalize(text) {
  return String(text || '').toLocaleLowerCase('bg').replace(/\s+/g, ' ').trim();
}

function cleanDetail(value) {
  return String(value || '')
    .replace(/^\s*(?:(?:че|е|на)\s+|[:;,—-]\s*)/iu, '')
    .replace(/^\s*да\s+/iu, '')
    .replace(/[\s,;:.!?…—-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeCommandLead(text, cue) {
  return text
    .slice(cue.index + cue[0].length)
    .replace(
      /^\s*(?:(?:в|за)\s+(?:дългосрочната|постоянната)\s+(?:си\s+)?памет(?:та)?\s*)?[,;:]?\s*(?:че\s+)?/iu,
      ''
    )
    .replace(
      /(?:[\s,;.!?]+)(?:потвърди(?:\s+ми)?|провери(?:\s+ми)?|кажи\s+ми\s+дали|само\s+ако|единствено\s+ако)[\s\S]*$/iu,
      ''
    )
    .trim();
}

function preferenceDetail(text) {
  const match = text.match(
    /(?:предпочитам|харесвам|обичам)\s+(?:(?:да)\s+)?(.+)|(?:предпочитани(?:ят|ата|те)?\s+ми|любима(?:та)?\s+ми|любимите\s+ми)\s+(?:вид\s+)?(?:тренировк[а-я]*|спорт|храна|храни|предпочитания)\s*(?:(?:е|са|:)\s*)?(.+)/iu
  );
  if (!match) return '';
  return cleanDetail(match[1] || match[2] || '');
}

function habitDetail(text) {
  const match = text.match(
    /(?:искам\s+да\s+си\s+изградя|имам|изградих|поддържам)\s+(?:си\s+)?навик(?:а|ът|ът\s+ми)?\s*(?:да\s+|е\s+да\s+)?(.+)|навикът\s+ми\s+е\s+да\s+(.+)/iu
  );
  if (match) return cleanDetail(match[1] || match[2] || '');
  return cleanDetail(text);
}

function detectExplicitPreferenceCommand(message) {
  if (typeof message !== 'string' || !message.trim()) return null;
  const text = normalize(message);
  const cue = EXPLICIT_MEMORY_CUE.exec(text);
  if (!cue) return null;

  const fact = removeCommandLead(text, cue);
  const detail = preferenceDetail(fact);
  const hasPreferenceCue = PREFERENCE_CUE.test(fact);
  const mentionsWorkout = WORKOUT_CUE.test(detail || fact);
  const mentionsFood = FOOD_CUE.test(detail || fact);
  const mentionsHabit = HABIT_CUE.test(fact);
  const ambiguousDomains =
    Number(mentionsWorkout) + Number(mentionsFood) + Number(mentionsHabit) > 1;

  if (!fact || fact.length > 240 || ambiguousDomains) {
    return hasPreferenceCue || mentionsWorkout || mentionsFood || mentionsHabit
      ? { kind: 'invalid_preference' }
      : null;
  }

  let domain = null;
  let value = '';

  // Repeated routines are habits even when they mention exercise or food.
  if (mentionsHabit) {
    domain = 'habit';
    value = habitDetail(fact);
  } else if (hasPreferenceCue && detail && mentionsWorkout) {
    domain = 'workout';
    value = detail;
  } else if (hasPreferenceCue && detail && mentionsFood) {
    domain = 'food';
    value = detail;
  } else if (hasPreferenceCue && detail) {
    domain = 'personal';
    value = detail;
  } else if (hasPreferenceCue || mentionsWorkout || mentionsFood) {
    return { kind: 'invalid_preference' };
  } else {
    return null;
  }

  value = cleanDetail(value);
  if (value.length < 2 || value.length > 180) {
    return { kind: 'invalid_preference' };
  }

  const dimension = DIMENSIONS[domain];
  const replaceExisting =
    domain === 'workout' || REPLACE_CUE.test(fact) || REPLACE_CUE.test(text.slice(0, cue.index));
  return {
    kind: 'save_preference',
    domain,
    category: dimension.category,
    prefix: dimension.prefix,
    value,
    replaceExisting,
  };
}

function saveExplicitPreference(userId, command) {
  if (
    (typeof userId !== 'string' && typeof userId !== 'number') ||
    !String(userId).trim() ||
    !command ||
    command.kind !== 'save_preference' ||
    !DIMENSIONS[command.domain] ||
    command.category !== DIMENSIONS[command.domain].category ||
    command.prefix !== DIMENSIONS[command.domain].prefix ||
    typeof command.value !== 'string' ||
    command.value.trim().length < 2 ||
    command.value.trim().length > 180
  ) {
    return { ok: false, reason: 'invalid' };
  }

  const expectedValue = `${command.prefix}${cleanDetail(command.value)}`;
  try {
    const existing = getRelationshipMemory(userId).filter(
      (entry) =>
        entry.category === command.category &&
        typeof entry.value === 'string' &&
        entry.value.startsWith(command.prefix)
    );
    const exact = existing.find((entry) => entry.value === expectedValue);

    if (!exact) {
      const current = existing.at(-1);
      if (current && command.replaceExisting) {
        updateRelationshipMemory(userId, current.id, expectedValue);
      } else {
        saveRelationshipMemory(userId, command.category, expectedValue);
      }
    }

    // Verify the exact value from the existing per-user store before callers
    // are allowed to acknowledge success.
    const persisted = getRelationshipMemory(userId).some(
      (entry) =>
        entry.category === command.category &&
        entry.value === expectedValue
    );
    if (!persisted) return { ok: false, reason: 'verification_failed' };

    return { ok: true, domain: command.domain, value: cleanDetail(command.value) };
  } catch {
    return { ok: false, reason: 'storage_failed' };
  }
}

module.exports = {
  detectExplicitPreferenceCommand,
  saveExplicitPreference,
};
