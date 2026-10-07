'use strict';

const { BRAIN_CONTRACT_VERSION, createBrainRequest } = require('./contracts');
const {
  getKnownProfileEntries,
  getUnknownProfilePaths,
  PROFILE_FIELD_PATHS,
} = require('./unifiedHealthProfile');

const CONTEXT_LIMITS = Object.freeze({
  longTermFacts: 8,
  healthEvents: 6,
  shortContext: 10,
  shortMessageCharacters: 480,
});

function normalizeText(value) {
  return String(value || '').trim();
}

function compactValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function normalizeFact(fact) {
  if (!fact || typeof fact !== 'object') return null;
  const value = normalizeText(fact.value);
  if (!value) return null;
  return {
    category: normalizeText(fact.category) || 'general',
    key: normalizeText(fact.key) || null,
    value,
    source: normalizeText(fact.source) || null,
    updatedAt: fact.updatedAt || null,
  };
}

function normalizedTokens(value) {
  return new Set(
    normalizeText(value)
      .toLowerCase()
      .match(/[a-z0-9а-я]+/giu) || []
  );
}

function isRelevantFact(fact, message) {
  if (['communication', 'communication_preferences'].includes(fact.category)) {
    return true;
  }

  const questionTokens = normalizedTokens(message);
  if (!questionTokens.size) return true;
  const factTokens = normalizedTokens(fact.category + ' ' + (fact.key || '') + ' ' + fact.value);
  for (const token of factTokens) {
    if (questionTokens.has(token)) return true;
  }
  return false;
}

function normalizeHealthEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const type = normalizeText(event.type);
  if (!type) return null;
  return {
    type,
    value: event.value === undefined ? null : event.value,
    unit: normalizeText(event.unit) || null,
    occurredAt: event.occurredAt || event.date || null,
  };
}

function normalizeShortContext(messages) {
  return messages
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => ({
      role: message.role,
      content: normalizeText(message.content).slice(0, CONTEXT_LIMITS.shortMessageCharacters),
    }))
    .filter((message) => message.content)
    .slice(-CONTEXT_LIMITS.shortContext);
}

// Builds a compact context packet. It deliberately emits only known profile
// fields; unknown values are carried as field paths for a possible single
// follow-up question, never converted to a guessed fact.
function buildContext(input = {}) {
  const request = createBrainRequest(input);
  const knownProfile = request.profile ? getKnownProfileEntries(request.profile) : [];
  const unknownProfilePaths = request.profile ? getUnknownProfilePaths(request.profile) : [];

  const longTermFacts = request.longTermFacts
    .map(normalizeFact)
    .filter(Boolean)
    .filter((fact) => isRelevantFact(fact, request.message))
    .slice(0, CONTEXT_LIMITS.longTermFacts);

  const healthEvents = request.healthEvents
    .map(normalizeHealthEvent)
    .filter(Boolean)
    .slice(0, CONTEXT_LIMITS.healthEvents);

  return {
    contractVersion: BRAIN_CONTRACT_VERSION,
    userId: request.userId,
    channel: request.channel,
    deliveryMode: request.deliveryMode,
    purpose: request.purpose,
    knownProfile,
    unknownProfilePaths,
    longTermFacts,
    healthEvents,
    shortContext: normalizeShortContext(request.shortContext),
  };
}

function renderContextForModel(context) {
  const lines = [
    'КОНТЕКСТ ЗА ТОЗИ ПОТРЕБИТЕЛ:',
    'Използвай само потвърдените факти по-долу. Не превръщай липсата на данни в предположение или отрицателен факт.',
  ];

  if (context.knownProfile.length) {
    lines.push('Потвърден профил:');
    for (const entry of context.knownProfile) {
      lines.push('- ' + entry.label + ': ' + compactValue(entry.value));
    }
  } else {
    lines.push('Все още няма потвърдени профилни данни.');
  }

  if (context.longTermFacts.length) {
    lines.push('Релевантни дългосрочни факти:');
    for (const fact of context.longTermFacts) {
      lines.push('- ' + fact.category + ': ' + fact.value);
    }
  }

  if (context.healthEvents.length) {
    lines.push('Последни здравни отчети:');
    for (const event of context.healthEvents) {
      const suffix = event.value === null ? '' : ': ' + event.value + (event.unit ? ' ' + event.unit : '');
      lines.push('- ' + event.type + suffix);
    }
  }

  if (context.shortContext.length) {
    lines.push('Кратък разговорен контекст:');
    for (const message of context.shortContext) {
      const role = message.role === 'user' ? 'Потребител' : 'Ели';
      lines.push('- ' + role + ': ' + message.content);
    }
  }

  if (context.unknownProfilePaths.length) {
    const labels = context.unknownProfilePaths
      .slice(0, 4)
      .map((path) => PROFILE_FIELD_PATHS[path]);
    lines.push(
      'Ако тази информация е наистина нужна за полезен отговор, задай най-много един кратък уточняващ въпрос. Не повтаряй въпрос за вече известен факт. Примери за все още непотвърдени области: ' +
        labels.join(', ') +
        '.'
    );
  }

  return lines.join('\n');
}

module.exports = {
  CONTEXT_LIMITS,
  buildContext,
  renderContextForModel,
};
