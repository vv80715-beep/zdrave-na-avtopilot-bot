const openai = require('./openaiClient');
const { getAllUserIds } = require('./storage');
const { getMemory, setLastCoachDate } = require('./memoryStorage');
const { isOwnerId } = require('./adminGuard');
const { generateCoach } = require('./coachService');
const { resolveEntitlementStatus } = require('./entitlementResolver');

const COACH_HOUR = Number.isFinite(parseInt(process.env.COACH_HOUR, 10))
  ? parseInt(process.env.COACH_HOUR, 10)
  : 9;

function todayKey() {
  return new Date().toISOString().split('T')[0];
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
// daily coaching once when the local hour first matches COACH_HOUR each day.
function startDailyCoaching(bot) {
  let lastRunDate = null;

  const tick = async () => {
    const now = new Date();
    if (now.getHours() === COACH_HOUR && lastRunDate !== todayKey()) {
      lastRunDate = todayKey();
      console.log(`Running daily coaching for ${todayKey()} at hour ${COACH_HOUR}.`);
      await runDailyCoaching(bot);
    }
  };

  // Check every minute.
  setInterval(tick, 60 * 1000);
  console.log(`Daily coaching scheduler started (target hour: ${COACH_HOUR}).`);
}

module.exports = { startDailyCoaching, runDailyCoaching };
