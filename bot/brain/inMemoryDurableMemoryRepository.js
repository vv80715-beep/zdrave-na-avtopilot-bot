'use strict';

function createInMemoryDurableMemoryRepository() {
  const profiles = new Map();
  const facts = new Map();
  const events = new Map();
  const shortContext = new Map();

  const key = (id) => String(id);

  return {
    async getProfile(userId) {
      return profiles.get(key(userId)) || null;
    },
    async putProfile(record) {
      profiles.set(key(record.telegramUserId), structuredClone(record));
      return structuredClone(record);
    },
    async listFacts(userId) {
      return structuredClone(facts.get(key(userId)) || []);
    },
    async appendFact(record) {
      const k = key(record.telegramUserId);
      const rows = facts.get(k) || [];
      const stored = {
        ...structuredClone(record),
        id: record.id || `fixture-${k}-${rows.length + 1}`,
        status: record.status || 'active',
      };
      rows.push(stored);
      facts.set(k, rows);
      return structuredClone(stored);
    },
    async updateFact(userId, factId, changes = {}) {
      const k = key(userId);
      const rows = facts.get(k) || [];
      const row = rows.find((fact) => String(fact.id) === String(factId) && fact.status !== 'deleted');
      if (!row) return null;
      Object.assign(row, structuredClone(changes), {
        telegramUserId: k,
        updatedAt: new Date().toISOString(),
      });
      return structuredClone(row);
    },
    async deleteFact(userId, factId) {
      const k = key(userId);
      const rows = facts.get(k) || [];
      const row = rows.find((fact) => String(fact.id) === String(factId) && fact.status !== 'deleted');
      if (!row) return null;
      row.status = 'deleted';
      row.updatedAt = new Date().toISOString();
      return structuredClone(row);
    },
    async listHealthEvents(userId, limit = 20) {
      return structuredClone((events.get(key(userId)) || []).slice(-limit));
    },
    async appendHealthEvent(record) {
      const k = key(record.telegramUserId);
      const rows = events.get(k) || [];
      rows.push(structuredClone(record));
      events.set(k, rows);
      return structuredClone(record);
    },
    async getShortContext(userId) {
      return structuredClone(shortContext.get(key(userId)) || null);
    },
    async putShortContext(record) {
      shortContext.set(key(record.telegramUserId), structuredClone(record));
      return structuredClone(record);
    },
    snapshot() {
      return {
        profiles: structuredClone([...profiles.entries()]),
        facts: structuredClone([...facts.entries()]),
        events: structuredClone([...events.entries()]),
        shortContext: structuredClone([...shortContext.entries()]),
      };
    },
  };
}

module.exports = { createInMemoryDurableMemoryRepository };
