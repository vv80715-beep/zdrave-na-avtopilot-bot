'use strict';

const { classifyMessage } = require('../relationshipMemory');
const { memoryFact } = require('./durableMemoryContracts');
const { validTelegramUserId } = require('./eliMemoryClient');

const TOPIC_PATTERNS = Object.freeze({
  workout: /(тренир|трениров|лост|калистен|собствено тегло|фитнес|спорт|упражнен|плув|бяган|тичам|йога|кросфит|пилат)/iu,
  food: /(хран|храна|овес|лещ|боб|риба|месо|пилешк|яйц|плод|зеленч|млечн|ориз)/iu,
  sleep: /(сън|съня|спя|спане|лягам|заспив|безсъние)/iu,
  goal: /(цел|искам да|планирам|стремя се)/iu,
  habit: /(навик|редовно|ежедневно|всеки ден)/iu,
});

const ACTIVE = 'active';

function cleanText(value, maxLength = 240) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function factTopic(fact) {
  if (Object.prototype.hasOwnProperty.call(TOPIC_PATTERNS, fact?.key)) {
    return fact.key;
  }
  const text = `${fact?.category || ''} ${fact?.key || ''} ${fact?.value || ''}`;
  for (const [topic, pattern] of Object.entries(TOPIC_PATTERNS)) {
    if (pattern.test(text)) return topic;
  }
  return null;
}

function activeAndScoped(userId, facts) {
  if (!Array.isArray(facts)) throw new TypeError('memory repository returned invalid facts');
  const foreign = facts.some(
    (fact) => String(fact?.telegramUserId ?? '') !== userId
  );
  if (foreign) throw new Error('memory repository scope mismatch');
  return facts.filter((fact) => fact.status == null || fact.status === ACTIVE);
}

function selectMatches(facts, target) {
  const text = cleanText(target).toLocaleLowerCase('bg');
  const topic = Object.entries(TOPIC_PATTERNS).find(([, pattern]) => pattern.test(text))?.[0];
  if (topic) return facts.filter((fact) => factTopic(fact) === topic);
  const tokens = text.match(/[а-яa-z0-9]{3,}/giu) || [];
  const scored = facts
    .map((fact) => {
      const value = `${fact.category || ''} ${fact.key || ''} ${fact.value || ''}`
        .toLocaleLowerCase('bg');
      const score = tokens.reduce((sum, token) => sum + (value.includes(token) ? 1 : 0), 0);
      return { fact, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const bestScore = scored[0].score;
  return scored.filter((item) => item.score === bestScore).map((item) => item.fact);
}

function createUniversalMemoryService(options = {}) {
  const repository = options.repository;
  if (
    !repository ||
    typeof repository.listFacts !== 'function' ||
    typeof repository.appendFact !== 'function' ||
    typeof repository.updateFact !== 'function' ||
    typeof repository.deleteFact !== 'function'
  ) {
    throw new TypeError('a complete memory repository is required');
  }

  function requireUserId(value) {
    const id = String(value ?? '').trim();
    if (!validTelegramUserId(id)) throw new TypeError('valid Telegram user ID required');
    return id;
  }

  async function listActive(userId) {
    return activeAndScoped(userId, await repository.listFacts(userId));
  }

  async function rememberMessage(userIdValue, message) {
    let userId;
    try {
      userId = requireUserId(userIdValue);
      const classified = classifyMessage(message);
      if (classified.action === 'ignore') {
        return { ok: false, confirmed: false, reason: 'not_a_memory_candidate' };
      }
      const value = cleanText(classified.value);
      if (!value) return { ok: false, confirmed: false, reason: 'invalid_fact' };

      const before = await listActive(userId);
      const duplicate = before.find(
        (fact) => fact.category === classified.category && fact.value === value
      );
      if (duplicate) {
        return { ok: true, confirmed: true, unchanged: true, fact: duplicate };
      }

      const saved = await repository.appendFact(memoryFact({
        telegramUserId: userId,
        category: classified.category,
        key: factTopic({ category: classified.category, value }),
        value,
        source: 'telegram',
        status: ACTIVE,
      }));
      const after = await listActive(userId);
      const verified = after.find((fact) =>
        (saved?.id && String(fact.id) === String(saved.id)) ||
        (fact.category === classified.category && fact.value === value)
      );
      if (
        !verified ||
        String(verified.telegramUserId) !== userId ||
        verified.category !== classified.category ||
        verified.value !== value
      ) {
        return { ok: false, confirmed: false, reason: 'write_not_verified' };
      }
      return { ok: true, confirmed: true, fact: verified };
    } catch {
      return { ok: false, confirmed: false, reason: 'storage_unavailable' };
    }
  }

  async function recall(userIdValue, query) {
    try {
      const userId = requireUserId(userIdValue);
      const facts = await listActive(userId);
      const matches = selectMatches(facts, query);
      return { ok: true, confirmed: true, facts: matches };
    } catch {
      return { ok: false, confirmed: false, reason: 'storage_unavailable', facts: [] };
    }
  }

  async function edit(userIdValue, target, newValue) {
    try {
      const userId = requireUserId(userIdValue);
      const value = cleanText(newValue);
      if (!value) return { ok: false, confirmed: false, reason: 'invalid_fact' };
      const facts = await listActive(userId);
      const matches = selectMatches(facts, target);
      if (matches.length !== 1) {
        return {
          ok: false,
          confirmed: false,
          reason: matches.length ? 'ambiguous_target' : 'fact_not_found',
        };
      }
      const current = matches[0];
      await repository.updateFact(userId, current.id, { value });
      const after = await listActive(userId);
      const verified = after.find(
        (fact) => String(fact.id) === String(current.id) && fact.value === value
      );
      if (!verified || String(verified.telegramUserId) !== userId) {
        return { ok: false, confirmed: false, reason: 'write_not_verified' };
      }
      return { ok: true, confirmed: true, fact: verified };
    } catch {
      return { ok: false, confirmed: false, reason: 'storage_unavailable' };
    }
  }

  async function forget(userIdValue, target = null) {
    try {
      const userId = requireUserId(userIdValue);
      const before = await listActive(userId);
      const matches = target == null || !String(target).trim()
        ? before
        : selectMatches(before, target);
      if (target != null && String(target).trim() && matches.length !== 1) {
        return {
          ok: false,
          confirmed: false,
          reason: matches.length ? 'ambiguous_target' : 'fact_not_found',
        };
      }
      if (!matches.length) {
        return { ok: true, confirmed: true, unchanged: true, deletedCount: 0 };
      }
      for (const fact of matches) {
        await repository.deleteFact(userId, fact.id);
      }
      const after = await listActive(userId);
      const remaining = new Set(after.map((fact) => String(fact.id)));
      if (matches.some((fact) => remaining.has(String(fact.id)))) {
        return { ok: false, confirmed: false, reason: 'delete_not_verified' };
      }
      return { ok: true, confirmed: true, deletedCount: matches.length };
    } catch {
      return { ok: false, confirmed: false, reason: 'storage_unavailable' };
    }
  }

  return Object.freeze({ rememberMessage, recall, edit, forget });
}

module.exports = { createUniversalMemoryService, selectMatches };
