'use strict';

const {
  getOwnerScopedEliV22Flags,
  hasVerifiedEliMemoryAccess,
  parseBooleanFlag,
} = require('./featureFlags');
const { detectMemoryCommand, isExplicitMemoryCue } = require('../relationshipMemory');

function createOwnerUniversalMemoryRuntime(options = {}) {
  const client = options.client;
  const service = options.service;
  const env = options.env || process.env;
  const now = options.now || Date.now;
  let verifiedAccess = null;

  if (!client || typeof client.checkAccess !== 'function') {
    throw new TypeError('a memory backend client is required');
  }
  if (
    !service ||
    typeof service.rememberMessage !== 'function' ||
    typeof service.recall !== 'function' ||
    typeof service.edit !== 'function' ||
    typeof service.forget !== 'function'
  ) {
    throw new TypeError('a complete universal memory service is required');
  }

  async function getFlags(isOwner) {
    const requested =
      parseBooleanFlag(env.ELI_V2_2_OWNER_CANARY_ENABLED, false) &&
      parseBooleanFlag(env.ELI_V2_2_DURABLE_MEMORY_ENABLED, false) &&
      parseBooleanFlag(env.ELI_V2_2_DURABLE_READS_ENABLED, false);
    if (!isOwner || !requested) {
      return { requested: false, flags: getOwnerScopedEliV22Flags(isOwner, { env }) };
    }

    if (!hasVerifiedEliMemoryAccess(verifiedAccess, now())) {
      try {
        verifiedAccess = await client.checkAccess();
      } catch {
        verifiedAccess = null;
      }
    }
    const flags = getOwnerScopedEliV22Flags(isOwner, {
      env,
      backendAccess: verifiedAccess,
      now: now(),
    });
    return { requested: true, flags };
  }

  async function handle(input = {}) {
    const userId = String(input.userId ?? '').trim();
    const isOwner = input.isOwner === true;
    const message = String(input.message ?? '');
    const command = detectMemoryCommand(message);
    const explicitSave = isExplicitMemoryCue(message);
    if (!isOwner || (!command && !explicitSave)) {
      return { handled: false };
    }

    const { requested, flags } = await getFlags(isOwner);
    if (!requested) return { handled: false };
    if (!flags.durableMemory || !flags.durableReads) {
      return {
        handled: true,
        reply: 'Не мога да потвърдя достъп до защитената дългосрочна памет. Нищо не е променено; опитай отново по-късно.',
        reason: 'backend_not_ready',
      };
    }

    let result;
    if (explicitSave) {
      result = await service.rememberMessage(userId, message);
      return {
        handled: true,
        reply: result.confirmed
          ? 'Запазих и проверих информацията в защитената ти дългосрочна памет.'
          : 'Не успях да потвърдя запис в защитената ти памет, затова няма да твърдя, че е запазен.',
        reason: result.reason || null,
      };
    }

    if (command.type === 'recall') {
      result = await service.recall(userId, message);
      if (!result.confirmed) {
        return {
          handled: true,
          reply: 'Не успях да проверя защитената ти памет, затова няма да гадая. Опитай отново.',
          reason: result.reason || 'read_unverified',
        };
      }
      return {
        handled: true,
        reply: result.facts.length
          ? `Ето какво намерих в защитената ти памет:\n${result.facts.map((fact) => `• ${fact.value}`).join('\n')}`
          : 'Не открих запазен факт по този въпрос.',
      };
    }

    if (command.type === 'update') {
      result = await service.edit(userId, command.target, command.value);
      return {
        handled: true,
        reply: result.confirmed
          ? 'Обнових и проверих записа в защитената ти памет.'
          : 'Не успях да потвърдя промяната. Нищо няма да представя като успешно записано.',
        reason: result.reason || null,
      };
    }

    if (command.type === 'forget') {
      result = await service.forget(
        userId,
        command.all ? null : command.target
      );
      return {
        handled: true,
        reply: result.confirmed
          ? 'Изтрих и проверих избрания запис в защитената ти памет.'
          : 'Не успях да потвърдя изтриването. Опитай отново.',
        reason: result.reason || null,
      };
    }

    return { handled: false };
  }

  async function prepareContext(input = {}) {
    const userId = String(input.userId ?? '').trim();
    const isOwner = input.isOwner === true;
    const message = String(input.message ?? '');
    const { requested, flags } = await getFlags(isOwner);
    if (
      !isOwner ||
      !requested ||
      !flags.durableReads ||
      detectMemoryCommand(message) ||
      isExplicitMemoryCue(message)
    ) {
      return { flags, facts: [], loaded: false };
    }

    try {
      const result = await service.recall(userId, message);
      if (!result.confirmed) {
        return {
          flags: Object.freeze({ ...flags, durableMemory: false, durableReads: false }),
          facts: [],
          loaded: false,
          reason: result.reason || 'read_unverified',
        };
      }
      return { flags, facts: result.facts, loaded: true };
    } catch {
      return {
        flags: Object.freeze({ ...flags, durableMemory: false, durableReads: false }),
        facts: [],
        loaded: false,
        reason: 'read_unverified',
      };
    }
  }

  return Object.freeze({ handle, prepareContext });
}

module.exports = { createOwnerUniversalMemoryRuntime };
