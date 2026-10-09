'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  APPROVED_ELI_MEMORY_BASE_URL,
  APPROVED_SUPABASE_PROJECT_REF,
  createEliMemoryClient,
} = require('../brain/eliMemoryClient');
const {
  DURABLE_MEMORY_CONTRACT_VERSION,
} = require('../brain/durableMemoryContracts');
const { getOwnerScopedEliV22Flags } = require('../brain/featureFlags');

const FIXTURE_SECRET = 'fixture-only-memory-secret';
const CONFIGURED_ENV = {
  ELI_MEMORY_BASE_URL: APPROVED_ELI_MEMORY_BASE_URL,
  ELI_MEMORY_INTERNAL_SECRET: FIXTURE_SECRET,
};

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

test('owner durable flags need explicit opt-in and recent approved backend verification', () => {
  const now = Date.UTC(2026, 9, 9, 12);
  const requested = {
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
