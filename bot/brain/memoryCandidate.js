'use strict';

const { BRAIN_CONTRACT_VERSION } = require('./contracts');
const {
  createProfileFieldUpdateProposal,
} = require('./unifiedHealthProfile');

const MEMORY_CANDIDATE_VERSION = BRAIN_CONTRACT_VERSION + '/memory-candidate';

const DAILY_EVENT_PATTERN =
  /(?:изпих|пих|изядох|ядох|закусих|обядвах|вечерях|тренирах|ходих|направих).{0,60}(?:вода|лит(?:ър|ра)|чаш|храна|калор|стъпк|км|километр|тренир|упражн)/iu;

const MEDICAL_PATTERN =
  /(?:диабет|диагноз|лекарств|доза|инсулин|антибиотик|симптом|изследван|болест|бремен)/iu;

const GOAL_TERMS =
  /(?:тегл|килограм|свал|отслаб|мускул|маса|сън|спя|хран|вода|движ|тренир|активност|навик|здрав|издръжлив)/iu;

function trimValue(value) {
  return String(value || '')
    .replace(/[.!?…]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function ignoredCandidate(reason) {
  return {
    contractVersion: MEMORY_CANDIDATE_VERSION,
    decision: 'ignore',
    reason,
    persistence: 'not_persisted',
    candidate: null,
  };
}

function normalizeTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
}

function extractCommunicationPreference(message) {
  if (!/(?:предпочитам|искам|отговаряй|пиши ми|давай ми)/iu.test(message)) return null;
  if (/(?:кратк|сбито|накратко)/iu.test(message)) {
    return {
      path: 'communication.responseLength',
      value: 'short',
      explicitCommand: false,
      kind: 'communication_preference',
    };
  }
  if (/(?:подробн|детайлн|обстойно|по-дълго)/iu.test(message)) {
    return {
      path: 'communication.responseLength',
      value: 'detailed',
      explicitCommand: false,
      kind: 'communication_preference',
    };
  }
  return null;
}

function extractGoal(message) {
  let match = message.match(
    /(?:промени|обнови|смени)\s+(?:основната\s+)?цел(?:та)?\s+ми\s+(?:на|в)\s+(.+)/iu
  );
  if (match && GOAL_TERMS.test(match[1])) {
    return {
      path: 'goals.primary',
      value: trimValue(match[1]),
      explicitCommand: true,
      kind: 'goal',
    };
  }

  match = message.match(/(?:^|[.!?]\s*)(?:моята\s+)?цел(?:та)?\s+ми\s+е\s+(.+)/iu);
  if (match && GOAL_TERMS.test(match[1])) {
    return {
      path: 'goals.primary',
      value: trimValue(match[1]),
      explicitCommand: false,
      kind: 'goal',
    };
  }
  return null;
}

function extractSleepSchedule(message) {
  let match = message.match(
    /(?:промени|обнови|смени).{0,50}(?:лягам|лягане|час\S*\s+за\s+сън).{0,30}?(?:на|в|към)\s*(\d{1,2}:\d{2})/iu
  );
  if (match) {
    const value = normalizeTime(match[1]);
    if (value) {
      return {
        path: 'sleep.bedtime',
        value,
        explicitCommand: true,
        kind: 'sleep_schedule',
      };
    }
  }

  match = message.match(
    /(?:обикновено|по\s+принцип|всяка\s+вечер|режимът\s+ми\s+е).{0,40}?лягам\s+(?:около|към|в)?\s*(\d{1,2}:\d{2})/iu
  );
  if (match) {
    const value = normalizeTime(match[1]);
    if (value) {
      return {
        path: 'sleep.bedtime',
        value,
        explicitCommand: false,
        kind: 'sleep_schedule',
      };
    }
  }
  return null;
}

function extractNutritionPreference(message) {
  if (!/(?:предпочитам|храня\s+се|ям|избягвам|режим)/iu.test(message)) return null;
  const match = message.match(
    /(?:вегетариан\S*|веган\S*|без\s+глутен|без\s+лактоза|растителн\S*\s+хранене)/iu
  );
  if (!match) return null;
  return {
    path: 'nutrition.preferences',
    value: trimValue(match[0]).toLowerCase(),
    explicitCommand: false,
    kind: 'nutrition_preference',
  };
}

function findExplicitFact(message) {
  return (
    extractCommunicationPreference(message) ||
    extractGoal(message) ||
    extractSleepSchedule(message) ||
    extractNutritionPreference(message)
  );
}

function proposalWithoutProfile(fact) {
  return {
    path: fact.path,
    action: fact.explicitCommand ? 'replace' : 'set',
    requiresConfirmation: false,
    current: null,
    proposed: {
      status: 'known',
      value: fact.value,
      source: 'explicit_user_statement',
      updatedAt: null,
    },
  };
}

// Extracts a proposal only. There is intentionally no storage dependency in
// this module, so it cannot write conversation text or mutate user data.
function extractMemoryCandidate(input = {}) {
  const message = trimValue(input.message);
  const safety = input.safety || null;

  if (!message) return ignoredCandidate('empty_message');
  if (safety && safety.allowMemoryCandidate === false) {
    return ignoredCandidate('safety_route');
  }
  if (MEDICAL_PATTERN.test(message)) {
    return ignoredCandidate('medical_data_requires_explicit_profile_flow');
  }
  if (DAILY_EVENT_PATTERN.test(message)) {
    return ignoredCandidate('daily_health_event');
  }

  const fact = findExplicitFact(message);
  if (!fact) return ignoredCandidate('not_a_clear_long_term_fact');

  const proposal = input.profile
    ? createProfileFieldUpdateProposal(input.profile, fact.path, fact.value, {
        source: 'explicit_user_statement',
        updatedAt: input.now || null,
        explicitCommand: fact.explicitCommand,
      })
    : proposalWithoutProfile(fact);

  return {
    contractVersion: MEMORY_CANDIDATE_VERSION,
    decision: 'candidate',
    persistence: 'not_persisted',
    candidate: {
      kind: fact.kind,
      target: 'health_profile_field',
      path: fact.path,
      value: fact.value,
      explicitCommand: fact.explicitCommand,
      requiresConfirmation: proposal.requiresConfirmation,
      proposal,
    },
  };
}

module.exports = {
  MEMORY_CANDIDATE_VERSION,
  extractMemoryCandidate,
  ignoredCandidate,
};
