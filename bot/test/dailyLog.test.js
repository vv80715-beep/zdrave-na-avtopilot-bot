// End-to-end tests for the daily health log retrieval pipeline.
// Runs with the built-in Node test runner: `npm test` (node --test).
//
// Storage is redirected to a throwaway temp dir via env vars BEFORE the modules
// are required, so tests never touch real user data.
const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-log-'));
process.env.DAILY_LOG_PATH = path.join(tmpDir, 'daily_logs.json');
process.env.USER_MEMORY_PATH = path.join(tmpDir, 'user_memory.json');

const { extractHealthEvents } = require('../dailyLogTracker');
const { recordEvents, resolveLogQuery, answerDailyLogQuery } = require('../dailyLogService');
const storage = require('../dailyLogStorage');

const USER_A = 111111;
const USER_B = 222222;

// Write via the real pipeline: parse free text → persist.
function log(userId, text) {
  const events = extractHealthEvents(text);
  assert.ok(events.length > 0, `expected "${text}" to parse into at least one event`);
  return recordEvents(userId, events);
}

// Read via the real pipeline: resolve intent → answer from storage.
function ask(userId, text) {
  const descriptor = resolveLogQuery(text);
  assert.ok(descriptor, `expected "${text}" to be recognized as a log query`);
  return answerDailyLogQuery(userId, descriptor);
}

function resetStorage() {
  for (const f of [process.env.DAILY_LOG_PATH, process.env.USER_MEMORY_PATH]) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }
}

test.beforeEach(resetStorage);

test('sleep: save and retrieve today', () => {
  log(USER_A, 'Спах 7 часа и 30 минути.');
  const answer = ask(USER_A, 'Колко спах днес?');
  assert.match(answer, /Сън/);
  assert.match(answer, /7 ч 30 мин/);
});

test('sleep: retrieve latest entry via query', () => {
  log(USER_A, 'Спах 6 часа.');
  const answer = ask(USER_A, 'Покажи последния запис за сън.');
  assert.match(answer, /Последен запис/);
  assert.match(answer, /6 ч/);
});

test('sleep: getLatest returns most recent across days', () => {
  const uid = String(USER_A);
  const data = {
    [uid]: {
      '2026-07-09': [
        { date: '2026-07-09', time: '22:00', category: 'sleep', value: '6 ч', amount: 6, unit: 'ч', at: '2026-07-09T19:00:00.000Z' },
      ],
      '2026-07-10': [
        { date: '2026-07-10', time: '23:00', category: 'sleep', value: '8 ч', amount: 8, unit: 'ч', at: '2026-07-10T20:00:00.000Z' },
      ],
    },
  };
  fs.writeFileSync(process.env.DAILY_LOG_PATH, JSON.stringify(data));
  const latest = storage.getLatest(USER_A, 'sleep');
  assert.strictEqual(latest.value, '8 ч');
});

test('water: save and retrieve today', () => {
  log(USER_A, 'Изпих 2 чаши вода.');
  const answer = ask(USER_A, 'Колко вода пих днес?');
  assert.match(answer, /Вода/);
  assert.match(answer, /2 чаши/);
});

test('weight: save and retrieve latest', () => {
  log(USER_A, 'Тежа 80 кг.');
  const answer = ask(USER_A, 'Какво е теглото ми?');
  assert.match(answer, /Тегло/);
  assert.match(answer, /80 кг/);
});

test('meals: save and retrieve today', () => {
  log(USER_A, 'Обядвах пилешко с ориз.');
  const answer = ask(USER_A, 'Какво ядох днес?');
  assert.match(answer, /Обяд/);
  assert.match(answer, /пилешко с ориз/);
});

test('activity: save and retrieve today', () => {
  log(USER_A, 'Тренирах 30 минути.');
  const answer = ask(USER_A, 'Тренирах ли днес?');
  assert.match(answer, /Тренировк/);
  assert.match(answer, /30/);
});

test('no data: clear message instead of an AI guess', () => {
  const answer = ask(USER_B, 'Колко спах днес?');
  assert.match(answer, /Няма записани данни/);
});

test('two users: data is fully isolated', () => {
  log(USER_A, 'Спах 8 часа.');
  log(USER_B, 'Спах 5 часа.');

  const a = ask(USER_A, 'Колко спах днес?');
  const b = ask(USER_B, 'Колко спах днес?');

  assert.match(a, /8 ч/);
  assert.doesNotMatch(a, /5 ч/);
  assert.match(b, /5 ч/);
  assert.doesNotMatch(b, /8 ч/);
});

test('a plain report is NOT treated as a query', () => {
  assert.strictEqual(resolveLogQuery('Спах 7 часа.'), null);
  assert.strictEqual(extractHealthEvents('Спах 7 часа.').length, 1);
});

test('generic "what did I log today" returns the day summary', () => {
  log(USER_A, 'Изпих 3 чаши вода.');
  const descriptor = resolveLogQuery('Какво записах днес?');
  assert.ok(descriptor);
  assert.strictEqual(descriptor.kind, 'summary');
  const answer = answerDailyLogQuery(USER_A, descriptor);
  assert.match(answer, /Обобщение за днес/);
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
