const fs = require('fs');
const path = require('path');

const STORAGE_PATH = path.join(__dirname, 'users.json');

function loadUsers() {
  if (!fs.existsSync(STORAGE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(STORAGE_PATH, JSON.stringify(users, null, 2), 'utf8');
}

function getUser(userId) {
  const users = loadUsers();
  return users[String(userId)] || null;
}

function saveUser(userId, profile) {
  const users = loadUsers();
  users[String(userId)] = profile;
  saveUsers(users);
}

function deleteUser(userId) {
  const users = loadUsers();
  delete users[String(userId)];
  saveUsers(users);
}

function getAllUserIds() {
  return Object.keys(loadUsers());
}

module.exports = { getUser, saveUser, deleteUser, getAllUserIds };
