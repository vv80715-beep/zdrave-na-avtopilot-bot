const openai = require('./openaiClient');
const { getAllUserIds } = require('./storage');
const { getMemory, setLastCoachDate } = require('./memoryStorage');
const { isOwnerId } = require('./adminGuard');
const { generateCoach } = require('./coachService');
const { resolveEntitlementStatus } = require('./entitlementResolver');
const { getSofiaDateKey, getSofiaTimeParts } = require('./sofiaTime');

const configuredCoachHour = Number(process.env.COACH_HOUR);
const COACH_HOUR =
  Number.isInteger(configuredCoachHour) && configuredCoachHour >= 0 && configuredCoachHour <= 23
    ? configuredCoachHour
    : 9;

let activeDailyCoachingScheduler = null;

function todayKey(now = new Date()) {
  return getSofiaDateKey(now);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Send one automatic daily coaching message per user, at most once per day.
async function runDailyCoaching(bot) {
  if (!openai) return;
  const today = todayKey();
  const userIds = getAllUserIds();

  for (const userId of userIds) {
    if (isOwnerId(userId)) continue; // owner is never auto-coached

    // Entitlement gate: users without active chat access (expired trial /
    // expired plan) are skipped entirely — zero OpenAI cost after expiry.
    if (!(await resolveEntitlementStatus(userId)).canChat) continue;

    const memory = getMemory(userId);
    if (memory?.lastCoachDate === today) continue; // already coached today

    try {
      const text = await generateCoach(openai, userId);
      if (text) {
        await bot.telegram.sendMessage(
          userId,
          `🌅 Доброто утро! Ето твоя коучинг за деня:\n\n${text}`
        );
        setLastCoachDate(userId, today);
        await sleep(1200); // gentle pacing to avoid rate limits
      }
    } catch (err) {
      // Common: user blocked the bot or never started a chat — skip quietly.
      console.error(`Daily coaching failed for ${userId}:`, err.message);
      // Still mark as attempted so we don't retry endlessly within the day.
      setLastCoachDate(userId, today);
    }
  }
}

// Lightweight minute-tick scheduler (no external cron dependency). Fires the
// daily coaching once when the Sofia hour first matches COACH_HOUR each day.
// The singleton and in-flight guard prevent duplicate timers/messages in one
// running bot process; persistent per-user lastCoachDate remains the restart
// dedupe guard.
function startDailyCoaching(bot, {
  coachHour = COACH_HOUR,
  nowFn = () => new Date(),
  runDailyCoachingFn = runDailyCoaching,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
} = {}) {
  if (activeDailyCoachingScheduler) return activeDailyCoachingScheduler;

  let lastRunDate = null;
  let inFlight = false;
  let stopped = false;

  const tick = async () => {
    if (stopped || inFlight) return;

    let acquired = false;
    try {
      const now = getSofiaTimeParts(nowFn());
      if (now.hour !== coachHour || lastRunDate === now.dateKey) return;

      inFlight = true;
      acquired = true;
      logger.log(`Running daily coaching for ${now.dateKey} at Sofia hour ${coachHour}.`);
      await runDailyCoachingFn(bot);
      lastRunDate = now.dateKey;
    } catch (err) {
      logger.error('Daily coaching scheduler tick error:', err.message);
    } finally {
      if (acquired) inFlight = false;
    }
  };

  // Check every minute and also immediately on boot. The immediate tick covers
  // a start/restart during the configured Sofia hour instead of missing it.
  const interval = setIntervalFn(() => {
    void tick();
  }, 60 * 1000);
  interval?.unref?.();

  const scheduler = {
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(interval);
      activeDailyCoachingScheduler = null;
    },
  };
  activeDailyCoachingScheduler = scheduler;
  logger.log(`Daily coaching scheduler started (target Sofia hour: ${coachHour}).`);
  scheduler.ready = tick();
  return scheduler;
}

module.exports = { startDailyCoaching, runDailyCoaching, todayKey };
