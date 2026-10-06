const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Low-level storage for Eli's RELATIONSHIP MEMORY — the durable personal context
// that helps her feel like a consistent companion (goals, preferences, recurring
// struggles, habits, meaningful progress …).
//
// This is a SEPARATE layer, intentionally kept apart from:
//   • health logs        → daily_logs.json      (dailyLogStorage.js)
//   • profile / memory    → user_memory.json     (memoryStorage.js)
//   • check-ins           → daily_progress.json  (checkinStorage.js)
//
// Shape on disk:
//   { [userId]: { memories: [ { id, category, value, createdAt, updatedAt } ],
//                 createdAt, updatedAt } }
//
// Each user's data lives under their own Telegram id key, so memory is fully
// isolated per user. The path is resolved per-call from RELATIONSHIP_MEMORY_PATH
// (falling back to the file next to this module) so tests can point it at a temp
// file without touching real user data.
// ─────────────────────────────────────────────────────────────────────────────

function storagePath() {
  return (
    process.env.RELATIONSHIP_MEMORY_PATH ||
    path.join(__dirname, 'relationship_memory.json')
  );
}

// The nine relationship-memory categories. The classifier and formatter both
// import this so the set of valid categories lives in exactly one place.
const CATEGORIES = [
  'goals',
  'communication_preferences',
  'recurring_challenges',
  'habits',
  'motivation',
  'personal_preferences',
  'follow_up_topics',
  'meaningful_progress',
  'relationship_context',
];

function isValidCategory(category) {
  return CATEGORIES.includes(category);
}

function load() {
  if (!fs.existsSync(storagePath())) return {};
  try {
    return JSON.parse(fs.readFileSync(storagePath(), 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(storagePath(), JSON.stringify(data, null, 2), 'utf8');
}

function emptyUser() {
  const now = new Date().toISOString();
  return { memories: [], createdAt: now, updatedAt: now };
}

// Short, collision-resistant id for a single memory entry.
function newId() {
  return `m_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

// All stored memories for a user (empty array if none). Never returns another
// user's data — lookups are strictly keyed by the given id.
function getUserMemories(userId) {
  const data = load();
  const entry = data[String(userId)];
  return entry && Array.isArray(entry.memories) ? entry.memories : [];
}

function addMemory(userId, category, value) {
  const data = load();
  const uid = String(userId);
  if (!data[uid]) data[uid] = emptyUser();
  const now = new Date().toISOString();
  const entry = { id: newId(), category, value, createdAt: now, updatedAt: now };
  data[uid].memories.push(entry);
  data[uid].updatedAt = now;
  save(data);
  return entry;
}

function updateMemory(userId, memoryId, value) {
  const data = load();
  const uid = String(userId);
  const user = data[uid];
  if (!user || !Array.isArray(user.memories)) return null;
  const entry = user.memories.find((m) => m.id === memoryId);
  if (!entry) return null;
  entry.value = value;
  entry.updatedAt = new Date().toISOString();
  user.updatedAt = entry.updatedAt;
  save(data);
  return entry;
}

function deleteMemory(userId, memoryId) {
  const data = load();
  const uid = String(userId);
  const user = data[uid];
  if (!user || !Array.isArray(user.memories)) return false;
  const before = user.memories.length;
  user.memories = user.memories.filter((m) => m.id !== memoryId);
  const removed = user.memories.length < before;
  if (removed) {
    user.updatedAt = new Date().toISOString();
    save(data);
  }
  return removed;
}

// Wipe all relationship memory for a single user (used by "forget everything"
// and for test isolation). Other users are never touched.
function deleteAllForUser(userId) {
  const data = load();
  const uid = String(userId);
  const existed = Boolean(data[uid]);
  delete data[uid];
  save(data);
  return existed;
}

module.exports = {
  CATEGORIES,
  isValidCategory,
  getUserMemories,
  addMemory,
  updateMemory,
  deleteMemory,
  deleteAllForUser,
};
