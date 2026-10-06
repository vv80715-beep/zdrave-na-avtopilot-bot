// Tests for Eli's Relationship Memory layer.
// Runs with the built-in Node test runner: `npm test` (node --test).
//
// Storage is redirected to a throwaway temp file via env var BEFORE the modules
// are required, so tests never touch real user data and stay isolated from the
// health-log / profile layers.
const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-relmem-'));
process.env.RELATIONSHIP_MEMORY_PATH = path.join(tmpDir, 'relationship_memory.json');
// Point the health-log layer at the same temp dir so we can prove the two
// layers never write into each other.
process.env.DAILY_LOG_PATH = path.join(tmpDir, 'daily_logs.json');
process.env.USER_MEMORY_PATH = path.join(tmpDir, 'user_memory.json');

const {
  saveRelationshipMemory,
  getRelationshipMemory,
  updateRelationshipMemory,
  deleteRelationshipMemory,
  findRelevantRelationshipMemory,
  classifyMessage,
  rememberFromMessage,
  buildRelationshipContext,
  formatRelationshipMemory,
  detectMemoryCommand,
  applyMemoryCommand,
} = require('../relationshipMemory');

const USER_A = 111111;
const USER_B = 222222;

function reset() {
  for (const f of [
    process.env.RELATIONSHIP_MEMORY_PATH,
    process.env.DAILY_LOG_PATH,
    process.env.USER_MEMORY_PATH,
  ]) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }
}

test.beforeEach(reset);
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// ── Classifier ───────────────────────────────────────────────────────────────

test('saves a goal from a clear intention', () => {
  const c = classifyMessage('Искам да кача мускулна маса.');
  assert.equal(c.action, 'save');
  assert.equal(c.category, 'goals');

  const { action, entry } = rememberFromMessage(USER_A, 'Искам да кача мускулна маса.');
  assert.equal(action, 'save');
  assert.equal(entry.category, 'goals');

  const stored = getRelationshipMemory(USER_A);
  assert.equal(stored.length, 1);
  assert.match(stored[0].value, /мускулна маса/i);
});

test('saves a communication preference (short answers)', () => {
  const c = classifyMessage('Предпочитам да ми отговаряш кратко.');
  assert.equal(c.action, 'save');
  assert.equal(c.category, 'communication_preferences');

  rememberFromMessage(USER_A, 'Предпочитам да ми отговаряш кратко.');
  const stored = getRelationshipMemory(USER_A);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].category, 'communication_preferences');
  assert.equal(stored[0].value, 'Кратки отговори');
});

test('classifies more required "should save" examples correctly', () => {
  assert.equal(classifyMessage('След работа трудно се мотивирам.').action, 'save');
  assert.equal(classifyMessage('След работа трудно се мотивирам.').category, 'recurring_challenges');
  assert.equal(classifyMessage('Искам да подобря съня си.').category, 'goals');
});

test('ignores irrelevant / casual messages', () => {
  for (const msg of ['Днес е топло.', 'Отивам до магазина.', 'Хаха.', 'След малко ще ям.']) {
    assert.equal(classifyMessage(msg).action, 'ignore', `expected "${msg}" to be ignored`);
    const { action } = rememberFromMessage(USER_A, msg);
    assert.equal(action, 'ignore', `expected "${msg}" not to be stored`);
  }
  assert.equal(getRelationshipMemory(USER_A).length, 0);
});

// ── CRUD ─────────────────────────────────────────────────────────────────────

test('updates an existing memory', () => {
  const entry = saveRelationshipMemory(USER_A, 'goals', 'Искам да подобря съня си');
  const updated = updateRelationshipMemory(USER_A, entry.id, 'Искам да кача мускулна маса');
  assert.equal(updated.id, entry.id);
  assert.match(updated.value, /мускулна маса/i);

  const stored = getRelationshipMemory(USER_A);
  assert.equal(stored.length, 1);
  assert.match(stored[0].value, /мускулна маса/i);
});

test('deletes a memory', () => {
  const entry = saveRelationshipMemory(USER_A, 'goals', 'Искам да подобря съня си');
  assert.equal(deleteRelationshipMemory(USER_A, entry.id), true);
  assert.equal(getRelationshipMemory(USER_A).length, 0);
  // Deleting a non-existent id is a safe no-op.
  assert.equal(deleteRelationshipMemory(USER_A, 'nope'), false);
});

test('prevents duplicate memories', () => {
  saveRelationshipMemory(USER_A, 'goals', 'Искам да подобря съня си');
  saveRelationshipMemory(USER_A, 'goals', 'Искам да подобря съня си.'); // same, trailing dot
  saveRelationshipMemory(USER_A, 'goals', 'искам да подобря съня си'); // same, different case
  assert.equal(getRelationshipMemory(USER_A).length, 1);
});

test('replaces a conflicting length preference instead of duplicating', () => {
  rememberFromMessage(USER_A, 'Предпочитам да ми отговаряш кратко.');
  rememberFromMessage(USER_A, 'Всъщност предпочитам подробни отговори.');
  const prefs = getRelationshipMemory(USER_A).filter(
    (m) => m.category === 'communication_preferences'
  );
  assert.equal(prefs.length, 1);
  assert.equal(prefs[0].value, 'Подробни отговори');
});

// ── Relevance retrieval ──────────────────────────────────────────────────────

test('retrieves memory relevant to the current message', () => {
  saveRelationshipMemory(USER_A, 'goals', 'Искам да подобря съня си');
  saveRelationshipMemory(USER_A, 'goals', 'Искам да кача мускулна маса');

  const relevant = findRelevantRelationshipMemory(USER_A, 'Напоследък пак си лягам късно.');
  assert.ok(relevant.length >= 1);
  assert.match(relevant[0].value, /съня/i);
  // The muscle goal is not relevant to a sleep message.
  assert.ok(!relevant.some((m) => /мускул/i.test(m.value)));
});

test('finds nothing relevant when the topic does not match', () => {
  saveRelationshipMemory(USER_A, 'goals', 'Искам да кача мускулна маса');
  assert.deepEqual(findRelevantRelationshipMemory(USER_A, 'Днес времето е хубаво.'), []);
});

// ── Isolation & anti-hallucination ──────────────────────────────────────────

test('keeps two users fully isolated', () => {
  saveRelationshipMemory(USER_A, 'goals', 'Искам да подобря съня си');
  saveRelationshipMemory(USER_B, 'goals', 'Искам да кача мускулна маса');

  const a = getRelationshipMemory(USER_A);
  const b = getRelationshipMemory(USER_B);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.match(a[0].value, /съня/i);
  assert.match(b[0].value, /мускул/i);
  // A cannot see B's memory when retrieving relevant items.
  assert.deepEqual(findRelevantRelationshipMemory(USER_A, 'мускулна маса'), []);
});

test('never invents memories: empty user yields no context and honest summary', () => {
  assert.deepEqual(getRelationshipMemory(USER_A), []);
  assert.equal(findRelevantRelationshipMemory(USER_A, 'Как да спя по-добре?').length, 0);
  assert.equal(buildRelationshipContext(USER_A, 'Как да спя по-добре?'), '');
  const summary = formatRelationshipMemory(USER_A);
  assert.match(summary, /още не съм запомнила/i);
});

test('does not mix relationship memory with health logs', () => {
  const { extractHealthEvents } = require('../dailyLogTracker');
  const { recordEvents } = require('../dailyLogService');

  // A health report is recorded in the health log …
  const events = extractHealthEvents('Изпих 2 литра вода днес.');
  assert.ok(events.length > 0);
  recordEvents(USER_A, events);

  // … but the relationship classifier ignores it, so nothing lands in rel-memory.
  assert.equal(classifyMessage('Изпих 2 литра вода днес.').action, 'ignore');
  rememberFromMessage(USER_A, 'Изпих 2 литра вода днес.');
  assert.equal(getRelationshipMemory(USER_A).length, 0);

  // The two layers live in different files.
  assert.notEqual(process.env.RELATIONSHIP_MEMORY_PATH, process.env.DAILY_LOG_PATH);
  const relRaw = fs.existsSync(process.env.RELATIONSHIP_MEMORY_PATH)
    ? fs.readFileSync(process.env.RELATIONSHIP_MEMORY_PATH, 'utf8')
    : '{}';
  assert.doesNotMatch(relRaw, /вода/i);
});

// ── Explicit memory commands ────────────────────────────────────────────────

test('recall command lists stored goals', () => {
  saveRelationshipMemory(USER_A, 'goals', 'Искам да кача мускулна маса');
  const cmd = detectMemoryCommand('Какви цели съм ти казвал?');
  assert.equal(cmd.type, 'recall');
  assert.equal(cmd.category, 'goals');
  const reply = applyMemoryCommand(USER_A, cmd);
  assert.match(reply, /мускулна маса/i);
});

test('forget command deletes the matching memory', () => {
  rememberFromMessage(USER_A, 'Предпочитам да ми отговаряш кратко.');
  assert.equal(getRelationshipMemory(USER_A).length, 1);

  const cmd = detectMemoryCommand('Забрави, че предпочитам кратки отговори.');
  assert.equal(cmd.type, 'forget');
  applyMemoryCommand(USER_A, cmd);
  assert.equal(getRelationshipMemory(USER_A).length, 0);
});

test('"забравих" (I forgot) is NOT treated as a forget command', () => {
  assert.equal(detectMemoryCommand('Забравих да пия вода днес.'), null);
});

test('update command replaces the goal', () => {
  saveRelationshipMemory(USER_A, 'goals', 'Искам да подобря съня си');
  const cmd = detectMemoryCommand('Промени целта ми на покачване на мускулна маса.');
  assert.equal(cmd.type, 'update');
  assert.equal(cmd.category, 'goals');
  applyMemoryCommand(USER_A, cmd);
  const goals = getRelationshipMemory(USER_A).filter((m) => m.category === 'goals');
  assert.equal(goals.length, 1);
  assert.match(goals[0].value, /мускулна маса/i);
});

// ── Natural, non-robotic use in conversation ────────────────────────────────

test('context weaves memory in naturally (sleep example) and honors comm prefs', () => {
  rememberFromMessage(USER_A, 'Искам да подобря съня си.');
  rememberFromMessage(USER_A, 'Предпочитам да ми отговаряш кратко.');

  const ctx = buildRelationshipContext(USER_A, 'Напоследък пак си лягам късно.');
  // The relevant sleep goal surfaces …
  assert.match(ctx, /съня/i);
  // … the short-answer preference becomes a behavioral instruction …
  assert.match(ctx, /кратко/i);
  // … and Eli is told to weave it in, not recite it like a database.
  assert.match(ctx, /естествено/i);
  assert.match(ctx, /никога не я изброявай/i);
  // The context must explicitly forbid the robotic "according to stored memory"
  // style of reply.
  assert.match(ctx, /никога не казвай/i);
});

test('context stays silent about unrelated memories', () => {
  // Only a muscle goal stored; a message about stress should not surface it.
  rememberFromMessage(USER_A, 'Искам да кача мускулна маса.');
  const ctx = buildRelationshipContext(USER_A, 'Днес времето е хубаво.');
  assert.doesNotMatch(ctx, /мускул/i);
});

test('summary is an honest grouped list of what is actually stored', () => {
  rememberFromMessage(USER_A, 'Искам да подобря съня си.');
  rememberFromMessage(USER_A, 'Предпочитам да ми отговаряш кратко.');
  const summary = formatRelationshipMemory(USER_A);
  assert.match(summary, /Цели/);
  assert.match(summary, /съня/i);
  assert.match(summary, /Кратки отговори/);
});
