const {
  getAllReminderUserIds,
  getReminders,
  markSent,
} = require('./reminderStorage');
const { isOwnerId } = require('./adminGuard');
const { CATEGORY_EMOJI } = require('./constants');
const { getSofiaTimeParts } = require('./sofiaTime');

let activeReminderScheduler = null;
let dueRemindersInFlight = false;

// Friendly, motivating line per category.
const CATEGORY_LINES = {
  water: 'Глътка вода сега ще те освежи! 💧',
  workout: 'Време е да раздвижиш тялото — ще се почувстваш страхотно! 💪',
  meal: 'Подхрани се добре, заслужаваш го. 🍽️',
  sleep: 'Започни да се успокояваш за спокоен сън. 😴',
  medication: 'Не забравяй да го вземеш навреме. 💊',
  custom: 'Малка стъпка към по-добрия ти ден! ✨',
};

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
async function runDueReminders(bot, {
  now = new Date(),
  getAllReminderUserIdsFn = getAllReminderUserIds,
  getRemindersFn = getReminders,
  markSentFn = markSent,
  isOwnerIdFn = isOwnerId,
} = {}) {
  if (dueRemindersInFlight) return;
  dueRemindersInFlight = true;

  try {
    const sofia = getSofiaTimeParts(now);
    const stamp = `${sofia.dateKey} ${sofia.hhmm}`;

    for (const userId of getAllReminderUserIdsFn()) {
      if (isOwnerIdFn(userId)) continue; // owner mode stays separate

      for (const reminder of getRemindersFn(userId)) {
        if (reminder.paused) continue;
        if (!Array.isArray(reminder.days) || !reminder.days.includes(sofia.weekday)) continue;
        if (reminder.time !== sofia.hhmm) continue;
        if (reminder.lastSent === stamp) continue; // never send a duplicate

        try {
          await bot.telegram.sendMessage(userId, buildMessage(reminder));
          markSentFn(userId, reminder.id, stamp);
        } catch (err) {
          if (isPermanentDeliveryError(err)) {
            // User blocked the bot / deactivated / chat gone — skip silently and
            // stamp so we never retry an unreachable chat.
            markSentFn(userId, reminder.id, stamp);
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
  } finally {
    dueRemindersInFlight = false;
  }
}

// Tick every 30s so each minute is covered at least once; the lastSent stamp
// guarantees a reminder is delivered only once per Sofia scheduled minute.
function startReminderScheduler(bot, {
  nowFn = () => new Date(),
  runDueRemindersFn = runDueReminders,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
} = {}) {
  if (activeReminderScheduler) return activeReminderScheduler;

  let stopped = false;
  let inFlight = false;
  const tick = () =>
    (async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        await runDueRemindersFn(bot, { now: nowFn() });
      } catch (err) {
        logger.error('Reminder scheduler tick error:', err.message);
      } finally {
        inFlight = false;
      }
    })();

  const interval = setIntervalFn(() => {
    void tick();
  }, 30 * 1000);
  interval?.unref?.();

  const scheduler = {
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(interval);
      activeReminderScheduler = null;
    },
  };
  activeReminderScheduler = scheduler;
  logger.log('Reminder scheduler started (30s tick, Europe/Sofia).');
  scheduler.ready = tick(); // reduce first-minute delivery lag after a restart
  return scheduler;
}

module.exports = { startReminderScheduler, runDueReminders };
