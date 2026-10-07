'use strict';

const DURABLE_MEMORY_CONTRACT_VERSION = 'eli-v2.2/durable-memory/1';

function userId(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new TypeError('telegram_user_id is required');
  }
  return String(value);
}

function profileRecord(input = {}) {
  return {
    contractVersion: DURABLE_MEMORY_CONTRACT_VERSION,
    telegramUserId: userId(input.telegramUserId),
    profile: input.profile || {},
    version: Number.isInteger(input.version) && input.version > 0 ? input.version : 1,
    createdAt: input.createdAt || null,
    updatedAt: input.updatedAt || null,
  };
}

function memoryFact(input = {}) {
  const value = String(input.value || '').trim();
  if (!value) throw new TypeError('memory fact value is required');
  return {
    contractVersion: DURABLE_MEMORY_CONTRACT_VERSION,
    telegramUserId: userId(input.telegramUserId),
    category: String(input.category || 'general'),
    key: input.key == null ? null : String(input.key),
    value,
    status: input.status || 'active',
    source: input.source || 'legacy',
    supersedesId: input.supersedesId || null,
    createdAt: input.createdAt || null,
    updatedAt: input.updatedAt || null,
  };
}

function healthEvent(input = {}) {
  const type = String(input.type || '').trim();
  if (!type) throw new TypeError('health event type is required');
  return {
    contractVersion: DURABLE_MEMORY_CONTRACT_VERSION,
    telegramUserId: userId(input.telegramUserId),
    type,
    value: input.value === undefined ? null : input.value,
    unit: input.unit || null,
    occurredAt: input.occurredAt || null,
    metadata: input.metadata || {},
  };
}

function shortContextRecord(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  return {
    contractVersion: DURABLE_MEMORY_CONTRACT_VERSION,
    telegramUserId: userId(input.telegramUserId),
    messages: messages.slice(-10),
    expiresAt: input.expiresAt || null,
    updatedAt: input.updatedAt || null,
  };
}

module.exports = {
  DURABLE_MEMORY_CONTRACT_VERSION,
  profileRecord,
  memoryFact,
  healthEvent,
  shortContextRecord,
};
