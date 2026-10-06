const fs = require('fs');
const path = require('path');

// Per-user daily health log. Stored separately from profiles (users.json),
// long-term memory (user_memory.json) and check-ins (daily_progress.json).
// Shape: { [userId]: { [YYYY-MM-DD]: [ entry, ... ] } }
// Each entry: { date, time, category, value, amount, unit, raw, at }
// The path is resolved per-call from DAILY_LOG_PATH (falling back to the file
// next to this module) so automated tests can point it at a temp file without
// touching real user data.
function storagePath() {
  return process.env.DAILY_LOG_PATH || path.join(__dirname, 'daily_logs.json');
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Dates and times are computed in Europe/Sofia so "today" matches the user's
// local day rather than UTC.
function sofiaParts(d = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Sofia',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return { date, time };
}

function todayKey() {
  return sofiaParts().date;
}

function dateKeyDaysAgo(n) {
  return sofiaParts(new Date(Date.now() - n * DAY_MS)).date;
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

// Append a single event to today's log. Fills in date, time and timestamp.
function addEntry(userId, { category, value, amount = null, unit = null, raw = null, mealType = null }) {
  const now = new Date();
  const { date, time } = sofiaParts(now);
  const data = load();
  const uid = String(userId);
  if (!data[uid]) data[uid] = {};
  if (!Array.isArray(data[uid][date])) data[uid][date] = [];
  const entry = { date, time, category, value, amount, unit, mealType, raw, at: now.toISOString() };
  data[uid][date].push(entry);
  save(data);
  return entry;
}

function getDay(userId, dateKey = todayKey()) {
  const data = load();
  return data[String(userId)]?.[dateKey] || [];
}

function getToday(userId) {
  return getDay(userId, todayKey());
}

// Flat, chronologically sorted list of entries from the last `days` calendar
// days (including today). Each entry carries its own `date`.
function getRange(userId, days = 7) {
  const data = load();
  const userDays = data[String(userId)] || {};
  const cutoff = dateKeyDaysAgo(days - 1);
  return Object.keys(userDays)
    .filter((dateKey) => dateKey >= cutoff)
    .sort((a, b) => a.localeCompare(b))
    .flatMap((dateKey) => userDays[dateKey]);
}

// Most recent stored entry of a category across ALL days for this user, or null.
// Used by "latest" queries ("покажи последния запис за сън", "latest weight").
// Timestamps are ISO strings, so lexicographic comparison equals chronological.
function getLatest(userId, category) {
  const data = load();
  const userDays = data[String(userId)] || {};
  let latest = null;
  for (const dateKey of Object.keys(userDays)) {
    for (const entry of userDays[dateKey]) {
      if (entry.category !== category) continue;
      if (!latest || String(entry.at) > String(latest.at)) latest = entry;
    }
  }
  return latest;
}

function deleteUserLog(userId) {
  const data = load();
  const uid = String(userId);
  const existed = Boolean(data[uid]);
  delete data[uid];
  save(data);
  return existed;
}

module.exports = {
  addEntry,
  getDay,
  getToday,
  getRange,
  getLatest,
  deleteUserLog,
  todayKey,
  sofiaParts,
};
