const {
  getAllReminderUserIds,
  getReminders,
  markSent,
} = require('./reminderStorage');
const { isOwnerId } = require('./adminGuard');
const { CATEGORY_EMOJI } = require('./constants');

// Friendly, motivating line per category.
const CATEGORY_LINES = {
  water: 'Глътка вода сега ще те освежи! 💧',
  workout: 'Време е да раздвижиш тялото — ще се почувстваш страхотно! 💪',
  meal: 'Подхрани се добре, заслужаваш го. 🍽️',
  sleep: 'Започни да се успокояваш за спокоен сън. 😴',
  medication: 'Не забравяй да го вземеш навреме. 💊',
  custom: 'Малка стъпка към по-добрия ти ден! ✨',
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function buildMessage(reminder) {
  const emoji = CATEGORY_EMOJI[reminder.category] || '⏰';
  const line = CATEGORY_LINES[reminder.category] || CATEGORY_LINES.custom;
  return `${emoji} Напомняне: ${reminder.title}\n\n${line}`;
}

// True only for errors where the chat is permanently unreachable (user blocked
// the bot, deactivated their account, or the chat no longer exists). Everything
// else (network blips, rate limits, 5xx) is treated as transient and retried.
function isPermanentDeliveryError(err) {
  const code = err?.response?.error_code ?? err?.code;
  const desc = (err?.response?.description || err?.description || err?.message || '')
    .toLowerCase();
  if (code === 403) return true; // bot was blocked / user deactivated
  if (
    code === 400 &&
    (desc.includes('chat not found') ||
      desc.includes('user not found') ||
      desc.includes('peer_id_invalid'))
  ) {
    return true;
  }
  return false;
}

// Fire any reminders that are due right now. A reminder is due when:
// active (not paused), today's weekday matches, the HH:MM matches, and it has
// not already been sent for this exact day+time (the lastSent dedupe stamp).
async function runDueReminders(bot) {
  const now = new Date();
  const weekday = now.getDay(); // 0 = Sunday
  const hhmm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const stamp = `${dateKey(now)} ${hhmm}`;

  for (const userId of getAllReminderUserIds()) {
    if (isOwnerId(userId)) continue; // owner mode stays separate

    for (const reminder of getReminders(userId)) {
      if (reminder.paused) continue;
      if (!Array.isArray(reminder.days) || !reminder.days.includes(weekday)) continue;
      if (reminder.time !== hhmm) continue;
      if (reminder.lastSent === stamp) continue; // never send a duplicate

      try {
        await bot.telegram.sendMessage(userId, buildMessage(reminder));
        markSent(userId, reminder.id, stamp);
      } catch (err) {
        if (isPermanentDeliveryError(err)) {
          // User blocked the bot / deactivated / chat gone — skip silently and
          // stamp so we never retry an unreachable chat.
          markSent(userId, reminder.id, stamp);
        } else {
          // Transient failure (network, rate limit, Telegram hiccup): do NOT
          // stamp, so the next 30s tick retries within the same minute.
          console.error(
            `Reminder send failed (will retry) for ${userId}/${reminder.id}:`,
            err.message
          );
        }
      }
    }
  }
}

// Tick every 30s so each minute is covered at least once; the lastSent stamp
// guarantees a reminder is delivered only once per scheduled minute.
function startReminderScheduler(bot) {
  const tick = () =>
    runDueReminders(bot).catch((err) =>
      console.error('Reminder scheduler tick error:', err.message)
    );
  tick(); // run once immediately to reduce first-minute delivery lag
  setInterval(tick, 30 * 1000);
  console.log('Reminder scheduler started (30s tick).');
}

module.exports = { startReminderScheduler, runDueReminders };
