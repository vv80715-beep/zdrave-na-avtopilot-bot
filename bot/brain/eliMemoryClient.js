'use strict';

const { DURABLE_MEMORY_CONTRACT_VERSION } = require('./durableMemoryContracts');

const APPROVED_SUPABASE_PROJECT_REF = 'aoaylzncorwakxcactox';
const APPROVED_ELI_MEMORY_BASE_URL =
  `https://${APPROVED_SUPABASE_PROJECT_REF}.supabase.co/functions/v1/eli-memory`;

function safeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validTelegramUserId(value) {
  return /^\d{1,20}$/.test(String(value ?? '').trim());
}

function mapFact(row) {
  return {
    id: String(row.id),
    telegramUserId: String(row.telegram_user_id),
    category: String(row.category),
    key: row.fact_key == null ? null : String(row.fact_key),
    value: String(row.value),
    status: String(row.status || 'active'),
    source: row.source == null ? null : String(row.source),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function createEliMemoryClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const baseUrl = String(env.ELI_MEMORY_BASE_URL || '').trim().replace(/\/+$/, '');
  const secret = String(env.ELI_MEMORY_INTERNAL_SECRET || '');
  const configured =
    baseUrl === APPROVED_ELI_MEMORY_BASE_URL &&
    secret.length > 0 &&
    typeof fetchImpl === 'function';
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, 15000)
    : 5000;

  async function request(method, route, body) {
    if (!configured) throw safeError('memory_backend_not_configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${baseUrl}${route}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-eli-memory-secret': secret,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!response || !response.ok) {
        throw safeError('memory_backend_unavailable');
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw safeError('memory_backend_invalid_response');
      }
      if (!payload || typeof payload !== 'object' || payload.error) {
        throw safeError('memory_backend_unavailable');
      }
      return payload;
    } catch (error) {
      if (error?.code) throw error;
      throw safeError('memory_backend_unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkAccess() {
    if (!configured) {
      return { ok: false, reason: 'backend_not_configured' };
    }
    try {
      const payload = await request('GET', '/health');
      if (
        payload.status !== 'ready' ||
        payload.project_ref !== APPROVED_SUPABASE_PROJECT_REF ||
        payload.contract_version !== DURABLE_MEMORY_CONTRACT_VERSION
      ) {
        return { ok: false, reason: 'backend_not_ready' };
      }
      return {
        ok: true,
        projectRef: payload.project_ref,
        contractVersion: payload.contract_version,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return { ok: false, reason: 'backend_unavailable' };
    }
  }

  async function listFacts(userId) {
    const id = String(userId ?? '').trim();
    if (!validTelegramUserId(id)) throw safeError('invalid_telegram_user_id');
    const payload = await request(
      'GET',
      `/?telegram_user_id=${encodeURIComponent(id)}`
    );
    if (
      String(payload.telegram_user_id ?? '') !== id ||
      !Array.isArray(payload.facts)
    ) {
      throw safeError('memory_backend_invalid_scope');
    }
    const facts = payload.facts.map((row) => {
      if (String(row.telegram_user_id ?? '') !== id) {
        throw safeError('memory_backend_invalid_scope');
      }
      return mapFact(row);
    });
    return facts.filter((fact) => fact.status === 'active');
  }

  async function appendFact(record) {
    const id = String(record?.telegramUserId ?? '').trim();
    if (!validTelegramUserId(id)) throw safeError('invalid_telegram_user_id');
    const payload = await request('POST', '/', {
      operation: 'save_fact',
      telegram_user_id: id,
      fact: {
        category: record.category,
        fact_key: record.key ?? null,
        value: record.value,
        source: record.source || 'telegram',
      },
    });
    if (!payload.ok || !payload.fact || String(payload.fact.telegram_user_id) !== id) {
      throw safeError('memory_write_unverified');
    }
    return mapFact(payload.fact);
  }

  async function updateFact(userId, factId, changes = {}) {
    const id = String(userId ?? '').trim();
    if (!validTelegramUserId(id) || !factId) throw safeError('invalid_memory_update');
    const payload = await request('POST', '/', {
      operation: 'update_fact',
      telegram_user_id: id,
      fact_id: String(factId),
      value: String(changes.value ?? ''),
    });
    if (!payload.ok || String(payload.telegram_user_id ?? '') !== id) {
      throw safeError('memory_write_unverified');
    }
    return { ok: true, id: String(factId) };
  }

  async function deleteFact(userId, factId) {
    const id = String(userId ?? '').trim();
    if (!validTelegramUserId(id) || !factId) throw safeError('invalid_memory_delete');
    const payload = await request('POST', '/', {
      operation: 'delete_fact',
      telegram_user_id: id,
      fact_id: String(factId),
    });
    if (!payload.ok || String(payload.telegram_user_id ?? '') !== id) {
      throw safeError('memory_write_unverified');
    }
    return { ok: true, id: String(factId) };
  }

  return Object.freeze({
    checkAccess,
    listFacts,
    appendFact,
    updateFact,
    deleteFact,
    configurationReady: configured,
  });
}

module.exports = {
  APPROVED_SUPABASE_PROJECT_REF,
  APPROVED_ELI_MEMORY_BASE_URL,
  createEliMemoryClient,
  validTelegramUserId,
};
