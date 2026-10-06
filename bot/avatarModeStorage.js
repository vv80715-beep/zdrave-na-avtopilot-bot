const fs = require('fs');
const path = require('path');

// Per-user chat mode: 'text' (default, "Говори с Ели"), 'voice' (spoken
// replies with Eli's voice) or 'avatar' ("Говори с аватара на Ели").
// Stored in its own JSON file, separate from all other stores. Path is
// overridable via env for tests. Unknown values always fall back to 'text'.
const FILE = process.env.AVATAR_MODE_PATH || path.join(__dirname, 'avatar_mode.json');

const VALID_MODES = new Set(['text', 'voice', 'avatar']);

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function getMode(userId) {
  const data = load();
  const mode = data[String(userId)];
  return VALID_MODES.has(mode) ? mode : 'text';
}

function setMode(userId, mode) {
  const data = load();
  data[String(userId)] = VALID_MODES.has(mode) ? mode : 'text';
  save(data);
  return getMode(userId);
}

function isAvatarMode(userId) {
  return getMode(userId) === 'avatar';
}

function isVoiceMode(userId) {
  return getMode(userId) === 'voice';
}

module.exports = { getMode, setMode, isAvatarMode, isVoiceMode };
