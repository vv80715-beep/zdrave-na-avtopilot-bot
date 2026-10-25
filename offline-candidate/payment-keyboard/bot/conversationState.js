const fs = require('fs');
const path = require('path');

// Single source of truth for WHEN Eli is allowed to greet. Every reply path
// (text, voice, owner, users) asks this module and nothing else decides on its
// own. Persisted to disk so a bot restart does NOT reset an active conversation
// back to "new" — otherwise a mid-chat user would be re-greeted after every
// deploy or crash.
const STATE_PATH = path.join(__dirname, 'conversation_state.json');
const GREETING_GAP_MS = 30 * 60 * 1000; // 30 minutes

function load() {
  if (!fs.existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function save(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    // Greeting freshness is best-effort — never crash a reply over it.
    console.error('Conversation state save failed:', err.message);
  }
}

// Record this inbound turn and report whether the conversation is:
//   'new'        — first time we've ever heard from this user
//   'returning'  — resumed after >= 30 min of silence
//   'continuing' — already flowing (no greeting allowed)
function touchConversationState(userId) {
  const uid = String(userId);
  const now = Date.now();
  const state = load();
  const prev = state[uid];
  state[uid] = now;
  save(state);
  if (!prev) return 'new';
  return now - prev >= GREETING_GAP_MS ? 'returning' : 'continuing';
}

module.exports = { touchConversationState, GREETING_GAP_MS };
