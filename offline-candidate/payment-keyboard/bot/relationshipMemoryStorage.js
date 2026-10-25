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
  'personal_facts',
  'plans',
  'constraints',
  'follow_up_topics',
  'meaningful_progress',
  'relationship_context',
];

function isValidCategory(category) {
  return CATEGORIES.includes(category);
}

function load() {
  if (!fs.existsSync(storagePath())) return {};
  const parsed = JSON.parse(fs.readFileSync(storagePath(), 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('relationship memory store must contain a JSON object');
  }
  return parsed;
}

function save(data) {
  const target = storagePath();
  const temporary = `${target}.${process.pid}.${require('crypto').randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
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
  const uid = requireUserId(userId);
  const data = load();
  const entry = data[uid];
  return entry && Array.isArray(entry.memories) ? entry.memories : [];
}

function addMemory(userId, category, value) {
  const uid = requireUserId(userId);
  if (!isValidCategory(category)) throw new TypeError('invalid relationship memory category');
  const data = load();
  if (!data[uid]) data[uid] = emptyUser();
  const now = new Date().toISOString();
  const entry = { id: newId(), category, value, createdAt: now, updatedAt: now };
  data[uid].memories.push(entry);
  data[uid].updatedAt = now;
  save(data);
  return entry;
}

function updateMemory(userId, memoryId, value) {
  const uid = requireUserId(userId);
  const data = load();
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
  const uid = requireUserId(userId);
  const data = load();
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
  const uid = requireUserId(userId);
  const data = load();
  const existed = Boolean(data[uid]);
  if (existed) {
    delete data[uid];
    save(data);
  }
  return existed;
}

function requireUserId(userId) {
  if (
    (typeof userId !== 'string' && typeof userId !== 'number') ||
    !String(userId).trim()
  ) {
    throw new TypeError('telegram user id is required');
  }
  return String(userId);
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
