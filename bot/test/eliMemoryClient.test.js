'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-v22-client-fixture-'));
process.env.RELATIONSHIP_MEMORY_PATH = path.join(tempDir, 'relationship-memory.json');
process.env.DAILY_LOG_PATH = path.join(tempDir, 'daily-logs.json');
process.env.USER_MEMORY_PATH = path.join(tempDir, 'user-memory.json');

const {
  APPROVED_ELI_MEMORY_BASE_URL,
  APPROVED_SUPABASE_PROJECT_REF,
  createEliMemoryClient,
} = require('../brain/eliMemoryClient');
const {
  DURABLE_MEMORY_CONTRACT_VERSION,
} = require('../brain/durableMemoryContracts');
const { getOwnerScopedEliV22Flags } = require('../brain/featureFlags');
const { createUniversalMemoryService } = require('../brain/universalMemoryService');

const FIXTURE_SECRET = 'fixture-only-memory-secret';
const CONFIGURED_ENV = {
  ELI_MEMORY_BASE_URL: APPROVED_ELI_MEMORY_BASE_URL,
  ELI_MEMORY_INTERNAL_SECRET: FIXTURE_SECRET,
};

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function response(payload, ok = true) {
  return {
    ok,
    status: ok ? 200 : 503,
    async json() {
      return payload;
    },
  };
}

test('backend access is closed when endpoint or internal secret is missing', async () => {
  let requests = 0;
  const client = createEliMemoryClient({
    env: {},
    fetchImpl: async () => {
      requests += 1;
      return response({});
    },
  });
  assert.equal(client.configurationReady, false);
  assert.deepEqual(await client.checkAccess(), {
    ok: false,
    reason: 'backend_not_configured',
  });
  assert.equal(requests, 0);
});

test('configured client accepts only the approved endpoint and verifies health contract', async () => {
  const calls = [];
  const client = createEliMemoryClient({
    env: CONFIGURED_ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({
        status: 'ready',
        project_ref: APPROVED_SUPABASE_PROJECT_REF,
        contract_version: DURABLE_MEMORY_CONTRACT_VERSION,
      });
    },
  });

  const readiness = await client.checkAccess();
  assert.equal(readiness.ok, true);
  assert.equal(readiness.projectRef, APPROVED_SUPABASE_PROJECT_REF);
  assert.equal(readiness.contractVersion, DURABLE_MEMORY_CONTRACT_VERSION);
  assert.ok(Number.isFinite(Date.parse(readiness.checkedAt)));
  assert.equal(calls[0].url, `${APPROVED_ELI_MEMORY_BASE_URL}/health`);
  assert.equal(calls[0].options.headers['x-eli-memory-secret'], FIXTURE_SECRET);

  const unapproved = createEliMemoryClient({
    env: {
      ...CONFIGURED_ENV,
      ELI_MEMORY_BASE_URL: 'https://other-project.supabase.co/functions/v1/eli-memory',
    },
    fetchImpl: async () => response({ status: 'ready' }),
  });
  assert.equal(unapproved.configurationReady, false);
  assert.equal((await unapproved.checkAccess()).ok, false);
});

test('client scopes reads and verifies returned memory fact owners', async () => {
  const row = {
    id: 'fixture-uuid',
    telegram_user_id: '610001',
    category: 'personal_preferences',
    fact_key: 'workout',
    value: 'тренирам на лостове',
    status: 'active',
    source: 'telegram',
  };
  const client = createEliMemoryClient({
    env: CONFIGURED_ENV,
    fetchImpl: async (url) => {
      assert.equal(
        url,
        `${APPROVED_ELI_MEMORY_BASE_URL}/?telegram_user_id=610001`
      );
      return response({ telegram_user_id: '610001', facts: [row] });
    },
  });
  const facts = await client.listFacts('610001');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].telegramUserId, '610001');
  assert.equal(facts[0].key, 'workout');

  const foreign = createEliMemoryClient({
    env: CONFIGURED_ENV,
    fetchImpl: async () =>
      response({
        telegram_user_id: '610001',
        facts: [{ ...row, telegram_user_id: '610002' }],
      }),
  });
  await assert.rejects(foreign.listFacts('610001'), /memory_backend_invalid_scope/);
});

test('a failed remote write does not leak response contents or the internal secret', async () => {
  const client = createEliMemoryClient({
    env: CONFIGURED_ENV,
    fetchImpl: async () => response({ error: `private ${FIXTURE_SECRET}` }, false),
  });
  await assert.rejects(
    client.appendFact({
      telegramUserId: '610011',
      category: 'goal',
      value: 'Fixture goal',
    }),
    (error) => {
      assert.equal(error.code, 'memory_backend_unavailable');
      assert.doesNotMatch(error.message, /fixture-only-memory-secret/);
      return true;
    }
  );
});

test('universal memory service completes scoped CRUD through the mock HTTP client', async () => {
  const facts = [];
  const calls = [];
  let nextId = 0;
  const client = createEliMemoryClient({
    env: CONFIGURED_ENV,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      const method = options.method;
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({
        method,
        path: parsed.pathname,
        operation: body?.operation || null,
        internalHeader: options.headers['x-eli-memory-secret'],
      });

      if (method === 'GET' && parsed.pathname.endsWith('/health')) {
        return response({
          status: 'ready',
          project_ref: APPROVED_SUPABASE_PROJECT_REF,
          contract_version: DURABLE_MEMORY_CONTRACT_VERSION,
        });
      }
      if (method === 'GET') {
        const telegramUserId = parsed.searchParams.get('telegram_user_id');
        return response({
          telegram_user_id: telegramUserId,
          facts: facts.filter((fact) => fact.telegram_user_id === telegramUserId),
        });
      }

      const telegramUserId = body.telegram_user_id;
      if (body.operation === 'save_fact') {
        const fact = {
          id: `fixture-row-${++nextId}`,
          telegram_user_id: telegramUserId,
          category: body.fact.category,
          fact_key: body.fact.fact_key,
          value: body.fact.value,
          source: body.fact.source,
          status: 'active',
        };
        facts.push(fact);
        return response({ ok: true, telegram_user_id: telegramUserId, fact });
      }
      if (body.operation === 'update_fact') {
        const fact = facts.find(
          (row) =>
            row.id === body.fact_id &&
            row.telegram_user_id === telegramUserId &&
            row.status === 'active'
        );
        if (!fact) return response({ error: 'fact_not_found' }, false);
        fact.value = body.value;
        return response({ ok: true, telegram_user_id: telegramUserId, fact });
      }
      if (body.operation === 'delete_fact') {
        const fact = facts.find(
          (row) =>
            row.id === body.fact_id &&
            row.telegram_user_id === telegramUserId &&
            row.status === 'active'
        );
        if (!fact) return response({ error: 'fact_not_found' }, false);
        fact.status = 'deleted';
        return response({
          ok: true,
          telegram_user_id: telegramUserId,
          fact_id: fact.id,
        });
      }
      return response({ error: 'unknown_operation' }, false);
    },
  });
  const memory = createUniversalMemoryService({ repository: client });

  const saved = await memory.rememberMessage(
    '610021',
    'Запомни, че предпочитам да тренирам на лостове.'
  );
  assert.equal(saved.confirmed, true);

  const edited = await memory.edit('610021', 'тренировки', 'Йога');
  assert.equal(edited.confirmed, true);
  assert.equal(edited.fact.value, 'Йога');

  const forgotten = await memory.forget('610021', 'тренировки');
  assert.equal(forgotten.confirmed, true);
  assert.deepEqual(await client.listFacts('610021'), []);

  assert.deepEqual(
    calls.filter((call) => call.method === 'POST').map((call) => call.operation),
    ['save_fact', 'update_fact', 'delete_fact']
  );
  assert.ok(calls.every((call) => call.internalHeader === FIXTURE_SECRET));
});

test('universal memory service refuses remote writes without verified backend access', async () => {
  let requests = 0;
  const client = createEliMemoryClient({
    env: {},
    fetchImpl: async () => {
      requests += 1;
      return response({});
    },
  });
  const memory = createUniversalMemoryService({ repository: client });

  const result = await memory.rememberMessage(
    '610022',
    'Запомни, че предпочитам да тренирам на лостове.'
  );
  assert.equal(result.ok, false);
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'backend_not_ready');
  assert.equal(requests, 0);
});

test('owner durable flags need explicit opt-in and recent approved backend verification', () => {
  const now = Date.UTC(2026, 9, 9, 12);
  const requested = {
    ELI_V2_2_OWNER_CANARY_ENABLED: 'true',
    ELI_V2_2_DURABLE_MEMORY_ENABLED: 'true',
    ELI_V2_2_DURABLE_READS_ENABLED: 'true',
  };
  const validAccess = {
    ok: true,
    projectRef: APPROVED_SUPABASE_PROJECT_REF,
    contractVersion: DURABLE_MEMORY_CONTRACT_VERSION,
    checkedAt: new Date(now).toISOString(),
  };

  const missingBackend = getOwnerScopedEliV22Flags(true, {
    env: requested,
    now,
  });
  assert.equal(missingBackend.durableMemory, false);
  assert.equal(missingBackend.durableReads, false);

  const wrongProject = getOwnerScopedEliV22Flags(true, {
    env: requested,
    backendAccess: { ...validAccess, projectRef: 'unapproved-project' },
    now,
  });
  assert.equal(wrongProject.durableMemory, false);
  assert.equal(wrongProject.durableReads, false);

  const staleAccess = getOwnerScopedEliV22Flags(true, {
    env: requested,
    backendAccess: {
      ...validAccess,
      checkedAt: new Date(now - 31_000).toISOString(),
    },
    now,
  });
  assert.equal(staleAccess.durableMemory, false);

  const enabled = getOwnerScopedEliV22Flags(true, {
    env: requested,
    backendAccess: validAccess,
    now,
  });
  assert.equal(enabled.durableMemory, true);
  assert.equal(enabled.durableReads, true);

  const readsWithoutMemory = getOwnerScopedEliV22Flags(true, {
    env: {
      ELI_V2_2_DURABLE_MEMORY_ENABLED: 'false',
      ELI_V2_2_DURABLE_READS_ENABLED: 'true',
    },
    backendAccess: validAccess,
    now,
  });
  assert.equal(readsWithoutMemory.durableMemory, false);
  assert.equal(readsWithoutMemory.durableReads, false);

  const customer = getOwnerScopedEliV22Flags(false, {
    env: requested,
    backendAccess: validAccess,
    now,
  });
  assert.equal(customer.durableMemory, false);
  assert.equal(customer.durableReads, false);
});
