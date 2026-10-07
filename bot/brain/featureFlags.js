'use strict';

// Every V2.2 flag defaults to false. Adding these files therefore has no effect
// on the production bot until a later, explicitly approved integration turns a
// flag on in a controlled environment.

const ELI_V2_2_FLAG_DEFAULTS = Object.freeze({
  aiBrain: false,
  contextBuilder: false,
  memoryCandidates: false,
  unifiedProfile: false,
  durableMemory: false,
  durableReads: false,
});

const ENVIRONMENT_FLAG_NAMES = Object.freeze({
  aiBrain: 'ELI_V2_2_AI_BRAIN_ENABLED',
  contextBuilder: 'ELI_V2_2_CONTEXT_BUILDER_ENABLED',
  memoryCandidates: 'ELI_V2_2_MEMORY_CANDIDATES_ENABLED',
  unifiedProfile: 'ELI_V2_2_UNIFIED_PROFILE_ENABLED',
  durableMemory: 'ELI_V2_2_DURABLE_MEMORY_ENABLED',
  durableReads: 'ELI_V2_2_DURABLE_READS_ENABLED',
});

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function getEliV22Flags(env = process.env) {
  const flags = {};
  for (const [key, environmentName] of Object.entries(ENVIRONMENT_FLAG_NAMES)) {
    flags[key] = parseBooleanFlag(env[environmentName], ELI_V2_2_FLAG_DEFAULTS[key]);
  }
  return Object.freeze(flags);
}

function resolveEliV22Flags(overrides = {}, env = process.env) {
  const flags = { ...getEliV22Flags(env) };
  for (const key of Object.keys(ELI_V2_2_FLAG_DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      flags[key] = Boolean(overrides[key]);
    }
  }
  return Object.freeze(flags);
}

function getOwnerScopedEliV22Flags(owner) {
  const enabledForOwner = Boolean(owner);
  return Object.freeze({
    aiBrain: enabledForOwner,
    contextBuilder: enabledForOwner,
    memoryCandidates: enabledForOwner,
    unifiedProfile: enabledForOwner,
    durableMemory: false,
    durableReads: false,
  });
}

module.exports = {
  ELI_V2_2_FLAG_DEFAULTS,
  ENVIRONMENT_FLAG_NAMES,
  parseBooleanFlag,
  getEliV22Flags,
  resolveEliV22Flags,
  getOwnerScopedEliV22Flags,
};
