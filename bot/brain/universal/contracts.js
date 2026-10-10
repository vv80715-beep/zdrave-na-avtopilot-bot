'use strict';

const crypto = require('node:crypto');

class MemoryError extends Error {
  constructor(code) { super(code); this.name = 'MemoryError'; this.code = code; }
}

function userId(value) {
  const id = String(value ?? '');
  if (!/^[1-9]\d{0,19}$/.test(id)) throw new MemoryError('invalid_user');
  return id;
}

function normalize(value) {
  return String(value).normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('bg');
}

function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
    throw new MemoryError('invalid_fact');
  }
  return value.trim();
}

const INSTRUCTION = /(?:игнорирай|забрави|пренебрегни).{0,50}(?:инструкци|правил|system)|(?:ignore|override|disregard).{0,50}(?:instruction|system|rules)|(?:system|developer)\s*[:>]|(?:разкрий|покажи|reveal|print).{0,50}(?:токен|ключ|чужд|other users|secret|api.?key)|<\/?(?:system|developer|assistant)>/iu;
const SECRET = /(?:парол|password|api[ _-]?key|access[ _-]?token|секретен ключ|private key|cvv|iban|номер.{0,15}карт)|\b\d(?:[ -]?\d){12,18}\b/iu;
const SENSITIVE = /диагноз|алерги|травм|заболяв|медицин|болест|лекарств|религи|политичес|сексуал|егн|лична карта|точн.{0,10}адрес|diagnos|allerg|injur|medical|disease|medication|religio|politic|sexual|passport|home address/iu;

function privacy(value) {
  if (INSTRUCTION.test(value) || SECRET.test(value)) return 'unsafe';
  if (SENSITIVE.test(value)) return 'sensitive';
  return 'ordinary';
}

// Intent is about the requested operation, never an allowlist of fact topics.
function intent(message) {
  const s = normalize(message).replace(/^(?:ели|eli)[,!:\s]+/u, '');
  if (/^(?:съгласен съм|съгласна съм|съгласявам се) да запазиш този чувствителен факт[.!]?$/u.test(s)) return 'consent';
  if (/^(?:забрави|изтрий|премахни) (?:цялата (?:си |ми )?памет(?: за мен)?|всичко(?:,? което (?:помниш|знаеш) за мен)?|всички (?:мои |лични )?факти)[.!]?$/u.test(s)) return 'clear';
  if (/^(?:запомни|помни|запиши|съхрани|remember|save)(?=$|[\s,;:!?.])/iu.test(s)) return 'remember';
  if (/^(?:промени|актуализирай|поправи|редактирай|update|change|correct)(?=$|[\s,;:!?.])/iu.test(s)) return 'update';
  if (/^(?:забрави|изтрий|премахни|forget|delete|remove)(?=$|[\s,;:!?.])/iu.test(s)) return 'delete';
  if (/^(?:какво (?:помниш|знаеш) за мен|покажи (?:ми )?(?:паметта|профила)|какви .{0,80}(?:съм ти|помниш)|припомни|помниш ли|what do you (?:remember|know)|recall)(?=$|[\s,;:!?.])/iu.test(s)) return 'recall';
  return null;
}

function emptyState() { return { version: 1, initialized: true, facts: [], receipts: [] }; }

function validateState(state) {
  if (!state || state.version !== 1 || state.initialized !== true || !Array.isArray(state.facts) || !Array.isArray(state.receipts) || state.facts.length > 200 || state.receipts.length > 50) {
    throw new MemoryError('corrupt_state');
  }
  const ids = new Set();
  for (const f of state.facts) {
    if (!f || typeof f.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(f.id) || ids.has(f.id) || typeof f.sensitive !== 'boolean') throw new MemoryError('corrupt_state');
    ids.add(f.id);
    text(f.topic, 160); text(f.value, 800);
    if (!Number.isFinite(Date.parse(f.createdAt)) || !Number.isFinite(Date.parse(f.updatedAt))) throw new MemoryError('corrupt_state');
  }
  for (const r of state.receipts) {
    if (!r || typeof r.id !== 'string' || r.id.length > 100 || !/^[a-f0-9]{64}$/u.test(r.hash)) throw new MemoryError('corrupt_state');
  }
  return state;
}

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function existingFact(facts, item) {
  // A topic is a display label, not a unique attribute key. Two unrelated
  // hobbies or plans may have the same label without describing the same fact.
  if (item.existingId !== null) {
    const existing = facts.find((f) => f.id === item.existingId);
    if (!existing) throw new MemoryError('invalid_selection');
    return existing;
  }
  // Exact duplicates remain idempotent even if extraction omits the old ID.
  const exact = facts.filter((f) => normalize(f.topic) === normalize(item.topic) && normalize(f.value) === normalize(item.value));
  if (exact.length > 1) throw new MemoryError('ambiguous_fact');
  return exact[0];
}

module.exports = { MemoryError, userId, normalize, text, privacy, intent, emptyState, validateState, hash, existingFact };
