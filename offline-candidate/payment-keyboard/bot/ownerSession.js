// In-RAM recent-turn buffer for the OWNER's conversations.
//
// The owner's durable memory is a separate identity and is intentionally never
// written to the per-user memory files. But natural multi-turn conversation
// ("Искам утре да тренирам 20 минути." → "Нека бъде нещо леко вкъщи.") needs
// the recent turns as real chat messages, or Eli loses the topic between
// consecutive messages. So the owner's turns live ONLY here, in memory:
// no disk writes, lost on restart — by design.

const OWNER_TURN_CAP = 10; // messages (~5 exchanges), mirrors recentMessages(10)

const turns = new Map(); // userId -> [{ role, content }]

function ownerRecentTurns(userId) {
  return turns.get(String(userId)) || [];
}

function ownerRememberTurn(userId, role, content) {
  const key = String(userId);
  const arr = turns.get(key) || [];
  arr.push({ role, content });
  while (arr.length > OWNER_TURN_CAP) arr.shift();
  turns.set(key, arr);
}

function clearOwnerTurns(userId) {
  turns.delete(String(userId));
}

module.exports = { ownerRecentTurns, ownerRememberTurn, clearOwnerTurns, OWNER_TURN_CAP };
