'use strict';

const { createEliBrain } = require('./eliBrain');
const { createUnknownHealthProfile } = require('./unifiedHealthProfile');
const { hasVerifiedEliMemoryAccess, resolveEliV22Flags } = require('./featureFlags');

function createStorageBackedEliBrain(options = {}) {
  if (!options.repository) throw new TypeError('repository is required');
  const repository = options.repository;
  const brain = options.brain || createEliBrain(options);
  const environment = options.environment || process.env;
  const ownerUserId = String(options.ownerUserId ?? '');

  return {
    async prepare(input = {}) {
      const userId = String(input.userId);
      const requestedFlags = resolveEliV22Flags(
        { ...(options.featureFlags || {}), ...(input.featureFlags || {}) },
        environment
      );
      let backendAccess = options.backendAccess;
      if (typeof backendAccess === 'function') {
        try {
          backendAccess = await backendAccess();
        } catch {
          backendAccess = null;
        }
      }
      const canReadDurableStorage =
        Boolean(ownerUserId) &&
        userId === ownerUserId &&
        requestedFlags.durableMemory === true &&
        requestedFlags.durableReads === true &&
        hasVerifiedEliMemoryAccess(backendAccess);

      const safeFlags = {
        ...(options.featureFlags || {}),
        ...(input.featureFlags || {}),
        durableMemory: canReadDurableStorage,
        durableReads: canReadDurableStorage,
      };
      const safeInput = {
        ...input,
        userId,
        featureFlags: safeFlags,
        profile: input.profile || createUnknownHealthProfile(userId),
        longTermFacts: input.longTermFacts || [],
        healthEvents: input.healthEvents || [],
        shortContext: input.shortContext || [],
      };

      if (!canReadDurableStorage) return brain.prepare(safeInput);

      try {
        const [storedProfile, facts, events, short] = await Promise.all([
          repository.getProfile(userId),
          repository.listFacts(userId),
          repository.listHealthEvents(userId, 6),
          repository.getShortContext(userId),
        ]);
        return brain.prepare({
          ...safeInput,
          profile: storedProfile?.profile || safeInput.profile,
          longTermFacts: facts || [],
          healthEvents: events || [],
          shortContext: short?.messages || [],
        });
      } catch {
        // A failed repository read disables the durable path for this turn.
        return brain.prepare({
          ...safeInput,
          featureFlags: { ...safeFlags, durableMemory: false, durableReads: false },
        });
      }
    },
  };
}

module.exports = { createStorageBackedEliBrain };
