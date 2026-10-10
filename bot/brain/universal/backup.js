'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { MemoryError, userId, hash, normalize, privacy, text, validateState, emptyState } = require('./contracts');
const { createChecksumManifest, verifyChecksumManifest } = require('../migration/backupManifest');
const { collectUserIssues } = require('../migration/legacyValidators');

const SOURCES = Object.freeze({
  users: 'users.json', userMemory: 'user_memory.json', relationshipMemory: 'relationship_memory.json',
  dailyLogs: 'daily_logs.json', checkins: 'daily_progress.json', reminders: 'reminders.json', conversationState: 'conversation_state.json',
});

async function readSources(directory) {
  const files = {};
  for (const filename of Object.values(SOURCES)) {
    try { files[filename] = await fs.readFile(path.join(directory, filename)); }
    catch (e) { if (e.code !== 'ENOENT') throw new MemoryError('backup_read_failed'); }
  }
  return files;
}

function parseSources(files) {
  const sources = {};
  for (const [name, filename] of Object.entries(SOURCES)) {
    if (!Object.hasOwn(files, filename)) { sources[name] = {}; continue; }
    try {
      // A damaged UTF-8 sequence must not turn into an apparently valid fact.
      const raw = files[filename];
      const content = Buffer.isBuffer(raw) ? new TextDecoder('utf-8', { fatal: true }).decode(raw) : raw;
      sources[name] = JSON.parse(content);
      if (!sources[name] || typeof sources[name] !== 'object' || Array.isArray(sources[name])) throw new Error();
    } catch { throw new MemoryError('corrupt_legacy'); }
  }
  const ids = new Set(Object.values(sources).flatMap((s) => Object.keys(s)));
  for (const id of ids) {
    userId(id);
    if (collectUserIssues(id, sources).length) throw new MemoryError('corrupt_legacy');
  }
  return sources;
}

async function writePrivate(filename, value) {
  if (!path.isAbsolute(filename)) throw new MemoryError('backup_path_invalid');
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const handle = await fs.open(filename, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
}

async function createBackup({ directory, filename, cipher }) {
  const files = await readSources(directory);
  // Save raw bytes before parsing: even a corrupt source has a recoverable backup.
  const backup = {
    version: 2,
    encoding: 'base64',
    manifest: createChecksumManifest(files),
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, bytes.toString('base64')])),
  };
  await writePrivate(filename, cipher.seal(backup, 'eli-legacy-backup:v1'));
  const verified = await loadBackup({ filename, cipher });
  const fresh = await readSources(directory);
  if (!verifyChecksumManifest(verified.manifest, fresh).ok) throw new MemoryError('legacy_changed_during_backup');
  parseSources(verified.files);
  return { files: Object.keys(files).length, verified: true };
}

async function loadBackup({ filename, cipher }) {
  let envelope;
  try { envelope = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch { throw new MemoryError('backup_read_failed'); }
  const backup = cipher.open(envelope, 'eli-legacy-backup:v1');
  if (!backup.files || typeof backup.files !== 'object' || Array.isArray(backup.files)) throw new MemoryError('backup_integrity_failed');
  if (backup.version === 2 && backup.encoding === 'base64') {
    const files = {};
    for (const [name, encoded] of Object.entries(backup.files)) {
      if (typeof encoded !== 'string') throw new MemoryError('backup_integrity_failed');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded) throw new MemoryError('backup_integrity_failed');
      files[name] = bytes;
    }
    backup.files = files;
  } else if (backup.version !== 1 || Object.values(backup.files).some((value) => typeof value !== 'string')) {
    throw new MemoryError('backup_integrity_failed');
  }
  if (!verifyChecksumManifest(backup.manifest, backup.files).ok) throw new MemoryError('backup_integrity_failed');
  return backup;
}

function uuid(seed) {
  const h = hash(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function candidatesFor(id, sources) {
  const rows = [];
  const push = (source, key, value) => {
    if (value === null || value === undefined || value === '') return;
    if (typeof value !== 'string') throw new MemoryError('corrupt_legacy');
    rows.push({ source, key, value: text(value, 800) });
  };
  for (const m of sources.relationshipMemory[id]?.memories || []) push('relationshipMemory', m.id || m.category || 'unknown', m.value);
  const memory = sources.userMemory[id] || {};
  // These are mappings of the EXISTING JSON schema, not permissible new topics.
  for (const key of ['injuries', 'allergies', 'favoriteFoods', 'dislikedFoods', 'dailyHabits']) push('userMemory', key, memory[key]);
  const profile = sources.users[id] || {};
  for (const key of ['firstName', 'goal', 'foodPreferences', 'activityLevel', 'trainingExperience', 'medicalNotes']) push('users', key, profile[key]);
  return rows;
}

async function reconcileBackup({ backup, semantic }) {
  const sources = parseSources(backup.files);
  const ids = [...new Set([sources.users, sources.userMemory, sources.relationshipMemory].flatMap(Object.keys))];
  const users = {};
  const counts = { users: ids.length, candidates: 0, imported: 0, duplicates: 0, conflicts: 0, held: 0 };
  for (const id of ids) {
    const facts = []; const held = [];
    for (const row of candidatesFor(id, sources)) {
      counts.candidates++;
      // No sensitive historical data is uploaded for AI reconciliation without fresh consent.
      if (privacy(`${row.key} ${row.value}`) !== 'ordinary' || /injuries|allergies|medicalNotes/iu.test(row.key)) {
        held.push({ ...row, reason: 'privacy_review' }); counts.held++; continue;
      }
      const message = `Архивиран собствен личен факт (${row.key}): ${row.value}`;
      const a = await semantic.analyze({ operation: 'migrate', message, facts });
      if (a.classification !== 'ordinary' || a.subject !== 'self' || a.facts.length !== 1 || a.facts[0].sensitive) {
        held.push({ ...row, reason: 'needs_review' }); counts.held++; continue;
      }
      const item = { ...a.facts[0], value: row.value }; // Preserve the complete historical value.
      const existing = facts.find((f) => f.id === item.existingId || normalize(f.topic) === normalize(item.topic));
      if (existing) {
        if ((item.relation === 'same' && item.existingId === existing.id) || normalize(existing.value) === normalize(item.value)) { counts.duplicates++; continue; }
        held.push({ ...row, reason: 'conflicting_fact', relatedId: existing.id }); counts.conflicts++; continue;
      }
      const stamp = new Date(0).toISOString();
      facts.push({ id: uuid(`${id}:${row.source}:${row.key}:${row.value}`), topic: item.topic, value: item.value, sensitive: false, createdAt: stamp, updatedAt: stamp, source: row.source });
      counts.imported++;
    }
    validateState({ ...emptyState(), facts });
    users[id] = { facts, held };
  }
  return { version: 1, backupHash: hash(JSON.stringify(backup.manifest)), users, counts };
}

async function writeReconciliation({ filename, plan, cipher }) {
  await writePrivate(filename, cipher.seal(plan, 'eli-memory-reconciliation:v1'));
  const read = cipher.open(JSON.parse(await fs.readFile(filename, 'utf8')), 'eli-memory-reconciliation:v1');
  if (hash(JSON.stringify(read)) !== hash(JSON.stringify(plan))) throw new MemoryError('backup_integrity_failed');
}

async function createVerifiedImporter({ directory, backupFilename, planFilename, cipher }) {
  const backup = await loadBackup({ filename: backupFilename, cipher });
  const archived = parseSources(backup.files);
  let plan;
  try { plan = cipher.open(JSON.parse(await fs.readFile(planFilename, 'utf8')), 'eli-memory-reconciliation:v1'); }
  catch { throw new MemoryError('reconciliation_missing'); }
  if (plan.version !== 1 || plan.backupHash !== hash(JSON.stringify(backup.manifest)) || !plan.users || typeof plan.users !== 'object') throw new MemoryError('reconciliation_invalid');
  for (const [id, row] of Object.entries(plan.users)) {
    userId(id); validateState({ ...emptyState(), facts: row.facts });
    if (!Array.isArray(row.held)) throw new MemoryError('reconciliation_invalid');
  }
  // The initialized state persists even after clear. Old JSON is never reimported.
  const importUser = async (id) => {
    id = userId(id);
    // Check only this sender's personal facts when first migrating. Journals and
    // conversation history keep changing independently; they must not break a restart.
    const current = parseSources(await readSources(directory));
    if (hash(JSON.stringify(candidatesFor(id, archived))) !== hash(JSON.stringify(candidatesFor(id, current)))) throw new MemoryError('legacy_changed_since_backup');
    const row = plan.users[id];
    if (row?.held.length) throw new MemoryError('legacy_review_required');
    return structuredClone(row?.facts || []);
  };
  importUser.readiness = { users: Object.keys(plan.users).length, blockedUsers: Object.values(plan.users).filter((row) => row.held.length > 0).length };
  return importUser;
}

module.exports = { SOURCES, readSources, parseSources, createBackup, loadBackup, reconcileBackup, writeReconciliation, createVerifiedImporter };
