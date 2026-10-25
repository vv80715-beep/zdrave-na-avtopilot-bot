'use strict';

const { BRAIN_CONTRACT_VERSION, SAFETY_LEVELS } = require('./contracts');

const URGENT_RULES = [
  {
    code: 'chest_pain',
    pattern: /(?:силн\S*\s+болк\S*\s+(?:в|на)\s+(?:гърд|гръд)|болк\S*\s+(?:в|на)\s+(?:гърд|гръд))/iu,
  },
  {
    code: 'breathing_difficulty',
    pattern: /(?:не\s+мога\s+да\s+дишам|силен\s+задух|затруднено\s+дишане)/iu,
  },
  {
    code: 'self_harm',
    pattern: /(?:самонараня|самоуби|искам\s+да\s+(?:се\s+)?убия)/iu,
  },
  {
    code: 'severe_bleeding',
    pattern: /(?:силно\s+кървен|кървя\s+много)/iu,
  },
];

const MEDICAL_PATTERN =
  /(?:лекарств|доза|инсулин|антибиотик|диагноз|симптом|изследван|кръвн|бремен|травм|контузи|диабет|болест)/iu;

const URGENT_RESPONSE =
  'Това може да е спешно. Не мога да преценя причината тук, но потърси незабавна медицинска помощ. Ако си в България и има непосредствен риск, обади се на 112 или помоли близък човек да остане с теб.';

function messageFrom(input) {
  if (typeof input === 'string') return input;
  return input && input.message ? String(input.message) : '';
}

function buildSafetyInstruction(route) {
  if (route.level === 'urgent') {
    return 'БЕЗОПАСНОСТ: това е потенциално спешна ситуация. Не поставяй диагноза, не давай инструкции за лечение и не извличай памет. Използвай само детерминистичната спешна насока.';
  }
  if (route.level === 'medical_caution') {
    return 'БЕЗОПАСНОСТ: темата е медицинска. Дай само обща wellness подкрепа, без диагноза, лекарства, дози или тълкуване на изследвания. Насочи към квалифициран медицински специалист при нужда. Не записвай медицински данни пасивно.';
  }
  return 'БЕЗОПАСНОСТ: давай wellness coaching, а не медицински съвет. Не поставяй диагнози и не измисляй липсващи лични данни.';
}

// Deterministic classification keeps urgent situations out of the LLM path in
// the future adapter. This first phase does not send anything itself.
function routeSafety(input) {
  const message = messageFrom(input).trim();
  const urgent = URGENT_RULES.find((rule) => rule.pattern.test(message));

  if (urgent) {
    const route = {
      contractVersion: BRAIN_CONTRACT_VERSION,
      level: 'urgent',
      reason: urgent.code,
      shouldCallModel: false,
      allowMemoryCandidate: false,
      responseText: URGENT_RESPONSE,
    };
    route.systemInstruction = buildSafetyInstruction(route);
    return route;
  }

  if (MEDICAL_PATTERN.test(message)) {
    const route = {
      contractVersion: BRAIN_CONTRACT_VERSION,
      level: 'medical_caution',
      reason: 'medical_topic',
      shouldCallModel: true,
      allowMemoryCandidate: false,
      responseText: null,
    };
    route.systemInstruction = buildSafetyInstruction(route);
    return route;
  }

  const route = {
    contractVersion: BRAIN_CONTRACT_VERSION,
    level: 'wellness',
    reason: 'wellness_or_general',
    shouldCallModel: true,
    allowMemoryCandidate: true,
    responseText: null,
  };
  route.systemInstruction = buildSafetyInstruction(route);
  return route;
}

module.exports = {
  SAFETY_LEVELS,
  URGENT_RESPONSE,
  routeSafety,
  buildSafetyInstruction,
};
