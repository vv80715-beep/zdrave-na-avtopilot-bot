const fs = require('fs');
const path = require('path');

const STORAGE_PATH = path.join(__dirname, 'reminders.json');

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

function genId() {
  return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function getReminders(userId) {
  const data = load();
  return data[String(userId)] || [];
}

function getReminder(userId, id) {
  return getReminders(userId).find((r) => r.id === id) || null;
}

function addReminder(userId, { title, time, days, category }) {
  const data = load();
  const uid = String(userId);
  if (!Array.isArray(data[uid])) data[uid] = [];
  const now = new Date().toISOString();
  const reminder = {
    id: genId(),
    title,
    time,
    days,
    category,
    paused: false,
    lastSent: null,
    createdAt: now,
    updatedAt: now,
  };
  data[uid].push(reminder);
  save(data);
  return reminder;
}

function updateReminder(userId, id, patch) {
  const data = load();
  const uid = String(userId);
  const list = data[uid] || [];
  const reminder = list.find((r) => r.id === id);
  if (!reminder) return null;
  Object.assign(reminder, patch, { updatedAt: new Date().toISOString() });
  save(data);
  return reminder;
}

function deleteReminder(userId, id) {
  const data = load();
  const uid = String(userId);
  const list = data[uid] || [];
  const idx = list.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  if (list.length === 0) delete data[uid];
  save(data);
  return true;
}

function setPaused(userId, id, paused) {
  return updateReminder(userId, id, { paused });
}

function markSent(userId, id, stamp) {
  return updateReminder(userId, id, { lastSent: stamp });
}

function getAllReminderUserIds() {
  return Object.keys(load());
}

module.exports = {
  getReminders,
  getReminder,
  addReminder,
  updateReminder,
  deleteReminder,
  setPaused,
  markSent,
  getAllReminderUserIds,
};
