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
      rows.push(structuredClone(record));
      facts.set(k, rows);
      return structuredClone(record);
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
