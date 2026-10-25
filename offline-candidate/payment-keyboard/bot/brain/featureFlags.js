'use strict';

// Every V2.2 flag defaults to false. The owner canary itself also requires
// explicit opt-in; process-wide flags never grant customers access.

const ELI_V2_2_FLAG_DEFAULTS = Object.freeze({
  aiBrain: false,
  contextBuilder: false,
  memoryCandidates: false,
  unifiedProfile: false,
  durableMemory: false,
  durableReads: false,
});

const ELI_V2_2_OWNER_CANARY_FLAGS = Object.freeze({
  ...ELI_V2_2_FLAG_DEFAULTS,
  aiBrain: true,
  contextBuilder: true,
  memoryCandidates: true,
  unifiedProfile: true,
});

const { DURABLE_MEMORY_CONTRACT_VERSION } = require('./durableMemoryContracts');
const { APPROVED_SUPABASE_PROJECT_REF } = require('./eliMemoryClient');
const MEMORY_ACCESS_MAX_AGE_MS = 30_000;

function hasVerifiedEliMemoryAccess(access, now = Date.now()) {
  const checkedAt = Date.parse(access?.checkedAt || '');
  return access?.ok === true &&
    access.projectRef === APPROVED_SUPABASE_PROJECT_REF &&
    access.contractVersion === DURABLE_MEMORY_CONTRACT_VERSION &&
    Number.isFinite(checkedAt) &&
    checkedAt <= now &&
    now - checkedAt <= MEMORY_ACCESS_MAX_AGE_MS;
}

function getOwnerScopedEliV22Flags(isOwner, options = {}) {
  const env = options.env || process.env;
  if (
    !isOwner ||
    !parseBooleanFlag(env.ELI_V2_2_OWNER_CANARY_ENABLED, false)
  ) {
    return ELI_V2_2_FLAG_DEFAULTS;
  }

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const accessVerified = hasVerifiedEliMemoryAccess(options.backendAccess, now);
  const durableMemory =
    accessVerified &&
    parseBooleanFlag(
      env.ELI_V2_2_DURABLE_MEMORY_ENABLED,
      ELI_V2_2_FLAG_DEFAULTS.durableMemory
    );
  const durableReads = durableMemory && parseBooleanFlag(
    env.ELI_V2_2_DURABLE_READS_ENABLED,
    ELI_V2_2_FLAG_DEFAULTS.durableReads
  );

  return Object.freeze({
    ...ELI_V2_2_OWNER_CANARY_FLAGS,
    durableMemory,
    durableReads,
  });
}

function getOwnerRelationshipMemoryCaptureEnabled(isOwner, env = process.env) {
  return Boolean(isOwner) &&
    parseBooleanFlag(env.ELI_OWNER_LOCAL_MEMORY_CAPTURE_ENABLED, false);
}

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

module.exports = {
  ELI_V2_2_FLAG_DEFAULTS,
  ELI_V2_2_OWNER_CANARY_FLAGS,
  MEMORY_ACCESS_MAX_AGE_MS,
  ENVIRONMENT_FLAG_NAMES,
  hasVerifiedEliMemoryAccess,
  getOwnerScopedEliV22Flags,
  getOwnerRelationshipMemoryCaptureEnabled,
  parseBooleanFlag,
  getEliV22Flags,
  resolveEliV22Flags,
};
