'use strict';

const path = require('node:path');
const { MemoryError, userId, intent } = require('./contracts');
const { createCipher } = require('./encryption');
const { createSupabaseRepository, createFileRepository } = require('./repositories');
const { createSemanticEngine } = require('./semantic');
const { createMemoryService, UNAVAILABLE } = require('./service');
const { createVerifiedImporter } = require('./backup');
const { parseBooleanFlag } = require('../featureFlags');

function createRuntime({ environment = process.env, openai, diagnostic = (event) => console.info(JSON.stringify(event)), importerFactory = createVerifiedImporter, repositoryFactory } = {}) {
  const enabled = parseBooleanFlag(environment.ELI_UNIVERSAL_MEMORY_ENABLED);
  const canaries = new Set(String(environment.ELI_UNIVERSAL_MEMORY_USERS || '').split(',').map((s) => s.trim()).filter(Boolean));
  const migrated = new Set(String(environment.ELI_UNIVERSAL_MEMORY_MIGRATED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean));
  const backend = environment.ELI_UNIVERSAL_MEMORY_BACKEND || 'supabase';
  let ready;
  function active(id) {
    try { id = userId(id); } catch { return false; }
    // Rollout MUST name exact senders. No accidental global rollout or owner bypass.
    return (enabled && canaries.has(id)) || migrated.has(id);
  }
  function service() {
    if (!ready) ready = (async () => {
      const cipher = createCipher(environment.ELI_UNIVERSAL_MEMORY_KEY);
      const semantic = createSemanticEngine({ openai });
      let repository;
      if (repositoryFactory) repository = repositoryFactory(cipher);
      else if (backend === 'supabase') repository = createSupabaseRepository({ url: environment.SUPABASE_URL, serviceKey: environment.SUPABASE_SERVICE_ROLE_KEY, cipher });
      else if (backend === 'file' && environment.NODE_ENV === 'test') repository = createFileRepository({ directory: environment.ELI_UNIVERSAL_MEMORY_DIRECTORY, cipher });
      else throw new MemoryError('repository_config_missing');
      const importUser = await importerFactory({ directory: path.resolve(environment.ELI_UNIVERSAL_MEMORY_LEGACY_DIRECTORY || path.join(__dirname, '../..')), backupFilename: environment.ELI_UNIVERSAL_MEMORY_BACKUP, planFilename: environment.ELI_UNIVERSAL_MEMORY_RECONCILIATION, cipher });
      return createMemoryService({ repository, semantic, importUser, diagnostic, canInitialize: (id) => enabled && canaries.has(id) });
    })().catch((e) => { ready = undefined; throw e; });
    return ready;
  }
  const isPrivate = (ctx) => ctx.chat?.type === 'private';
  return {
    active,
    async handle(ctx, message) {
      if (!active(ctx.from?.id)) return { handled: false };
      if (!isPrivate(ctx)) return intent(message) ? { handled: true, status: 'private_only', text: 'Управлявай личната памет в личния чат с Ели.' } : { handled: false };
      if (!intent(message)) return { handled: false };
      if (!(enabled && canaries.has(String(ctx.from.id))) && intent(message) !== 'recall') return { handled: true, status: 'read_only', text: 'Личната памет временно е само за четене. Не потвърждавам промяна.' };
      try { return await (await service()).handle({ user: ctx.from.id, message, privateChat: true, requestId: String(ctx.update?.update_id ?? ctx.message?.message_id ?? '') || undefined }); }
      catch { diagnostic({ component: 'universal_memory', result: 'failed', code: 'runtime_not_ready' }); return { handled: true, status: 'failed', text: UNAVAILABLE }; }
    },
    async show(ctx) {
      if (!isPrivate(ctx)) return 'Покажи паметта в личния чат с Ели.';
      try { return await (await service()).show(ctx.from.id); } catch { return UNAVAILABLE; }
    },
    async context(ctx, message) {
      if (!active(ctx.from?.id)) return '';
      if (!isPrivate(ctx)) return '\nТова е групов разговор. Не използвай лична памет или частни разговори. Не твърди, че знаеш, записваш, променяш или изтриваш лични факти. Насочи управлението на паметта към личния чат.';
      try { return await (await service()).context(ctx.from.id, message); }
      catch { return '\nПостоянната памет е недостъпна. Не твърди, че познаваш, записваш или изтриваш запазени лични факти.'; }
    },
    status() { return { enabled, backend, scope: 'explicit_canary_users', rollbackProtection: migrated.size > 0, persistenceVerified: false }; },
  };
}

let singleton;
function getUniversalMemoryRuntime() {
  if (!singleton) singleton = createRuntime({ openai: require('../../openaiClient') });
  return singleton;
}

module.exports = { createRuntime, getUniversalMemoryRuntime };
