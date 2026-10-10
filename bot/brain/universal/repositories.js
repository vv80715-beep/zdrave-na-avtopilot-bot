'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { MemoryError, userId, validateState, hash } = require('./contracts');

function decodeRow(row, id, cipher) {
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new MemoryError('corrupt_state');
  return { revision: row.revision, state: validateState(cipher.open(row.payload, `eli-memory:${id}:${row.revision}`)) };
}

function createFileRepository({ directory, cipher }) {
  if (!path.isAbsolute(directory || '') || !cipher) throw new MemoryError('repository_config_missing');
  const filename = (id) => path.join(directory, `${hash(userId(id))}.json`);
  async function read(id) {
    id = userId(id);
    let raw;
    try { raw = await fs.readFile(filename(id), 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return null; throw new MemoryError('storage_unavailable'); }
    let row;
    try { row = JSON.parse(raw); } catch { throw new MemoryError('corrupt_state'); }
    return decodeRow(row, id, cipher);
  }
  async function compareAndSwap(id, expectedRevision, state) {
    id = userId(id); validateState(state);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = filename(id);
    let lock;
    try { lock = await fs.open(`${file}.lock`, 'wx', 0o600); }
    catch (e) { throw new MemoryError(e.code === 'EEXIST' ? 'write_conflict' : 'storage_unavailable'); }
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const old = await read(id);
      if ((old?.revision || 0) !== expectedRevision) throw new MemoryError('write_conflict');
      const revision = expectedRevision + 1;
      const row = { revision, payload: cipher.seal(state, `eli-memory:${id}:${revision}`) };
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(row)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, file);
      const dir = await fs.open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      return revision;
    } finally {
      await fs.rm(temp, { force: true });
      await lock.close();
      await fs.rm(`${file}.lock`, { force: true });
    }
  }
  return { backend: 'file', read, compareAndSwap };
}

function createSupabaseRepository({ url, serviceKey, cipher, fetchImpl = globalThis.fetch }) {
  let origin;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error();
    origin = u.origin;
  } catch { throw new MemoryError('repository_config_missing'); }
  if (!serviceKey || !cipher || typeof fetchImpl !== 'function') throw new MemoryError('repository_config_missing');
  async function request(endpoint, method = 'GET', body) {
    try {
      const response = await fetchImpl(`${origin}/rest/v1/${endpoint}`, {
        method, signal: AbortSignal.timeout(10000), redirect: 'error',
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new MemoryError('storage_unavailable');
      return await response.json();
    } catch { throw new MemoryError('storage_unavailable'); }
  }
  return {
    backend: 'supabase',
    async read(id) {
      id = userId(id);
      const rows = await request(`eli_memory_state?telegram_user_id=eq.${id}&select=telegram_user_id,revision,payload`);
      if (!Array.isArray(rows) || rows.length > 1) throw new MemoryError('corrupt_state');
      if (!rows.length) return null;
      if (rows[0].telegram_user_id !== id) throw new MemoryError('user_isolation_failed');
      return decodeRow(rows[0], id, cipher);
    },
    async compareAndSwap(id, expectedRevision, state) {
      id = userId(id); validateState(state);
      const revision = expectedRevision + 1;
      const result = await request('rpc/eli_memory_compare_and_swap', 'POST', {
        p_user_id: id, p_expected_revision: expectedRevision,
        p_payload: cipher.seal(state, `eli-memory:${id}:${revision}`),
      });
      if (result === null) throw new MemoryError('write_conflict');
      if (result !== revision) throw new MemoryError('unverified_write');
      return revision;
    },
  };
}

module.exports = { createFileRepository, createSupabaseRepository };
