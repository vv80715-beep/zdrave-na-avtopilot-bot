const fs = require('fs');
const path = require('path');

const STORAGE_PATH = path.join(__dirname, 'daily_progress.json');

function todayKey() {
  return new Date().toISOString().split('T')[0];
}

function load() {
  if (!fs.existsSync(STORAGE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(STORAGE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function saveCheckin(userId, answers) {
  const data = load();
  const uid = String(userId);
  if (!data[uid]) data[uid] = {};
  data[uid][todayKey()] = { ...answers, completedAt: new Date().toISOString() };
  save(data);
}

function getTodayCheckin(userId) {
  const data = load();
  return data[String(userId)]?.[todayKey()] || null;
}

function getHistory(userId, days = 7) {
  const data = load();
  const userDays = data[String(userId)] || {};
  return Object.entries(userDays)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, days)
    .map(([date, entry]) => ({ date, ...entry }));
}

function getAllCheckins(userId) {
  const data = load();
  const userDays = data[String(userId)] || {};
  return Object.entries(userDays)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entry]) => ({ date, ...entry }));
}

module.exports = { saveCheckin, getTodayCheckin, getHistory, getAllCheckins, todayKey };
