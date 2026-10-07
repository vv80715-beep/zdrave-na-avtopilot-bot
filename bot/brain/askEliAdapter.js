'use strict';

const { createEliBrain, ELI_BRAIN_MODEL } = require('./eliBrain');
const { createUnknownHealthProfile } = require('./unifiedHealthProfile');
const { getShortContext, rememberShortTurn } = require('./shortContextSession');

function createAskEliAdapter(options = {}) {
  const brain = options.brain || createEliBrain({
    featureFlags: options.featureFlags,
    environment: options.environment,
  });

  function prepare(input = {}) {
    const userId = String(input.userId);
    const prepared = brain.prepare({
      userId,
      channel: input.channel || 'text',
      message: input.message || '',
      conversationState: input.conversationState || 'unknown',
      profile: input.profile || createUnknownHealthProfile(userId),
      longTermFacts: input.longTermFacts || [],
      healthEvents: input.healthEvents || [],
      shortContext: input.shortContext || getShortContext(userId),
      now: input.now || null,
    });

    return {
      ...prepared,
      providerModel: ELI_BRAIN_MODEL,
      legacy: prepared.route === 'legacy',
    };
  }

  function rememberExchange(userId, question, answer) {
    rememberShortTurn(userId, 'user', question);
    rememberShortTurn(userId, 'assistant', answer);
  }

  return Object.freeze({
    prepare,
    rememberExchange,
    getShortContext,
  });
}

module.exports = {
  createAskEliAdapter,
};
