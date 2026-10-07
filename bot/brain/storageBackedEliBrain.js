'use strict';

const { createEliBrain } = require('./eliBrain');
const { createUnknownHealthProfile } = require('./unifiedHealthProfile');

function createStorageBackedEliBrain(options = {}) {
  if (!options.repository) throw new TypeError('repository is required');
  const repository = options.repository;
  const brain = options.brain || createEliBrain(options);

  return {
    async prepare(input = {}) {
      const userId = String(input.userId);
      const storedProfile = await repository.getProfile(userId);
      const facts = await repository.listFacts(userId);
      const events = await repository.listHealthEvents(userId, 6);
      const short = await repository.getShortContext(userId);

      return brain.prepare({
        ...input,
        userId,
        profile: storedProfile?.profile || input.profile || createUnknownHealthProfile(userId),
        longTermFacts: facts || [],
        healthEvents: events || [],
        shortContext: short?.messages || [],
      });
    },
  };
}

module.exports = { createStorageBackedEliBrain };
