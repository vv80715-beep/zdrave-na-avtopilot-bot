// Keep long-polling startup orchestration separate from index.js so it can be
// regression-tested without creating a Telegram polling instance.
function startBotRuntime(bot, dependencies = {}) {
  if (!bot || typeof bot.launch !== 'function') {
    throw new TypeError('A Telegraf bot with launch() is required.');
  }

  const startSubscriptionExpiryScheduler =
    dependencies.startSubscriptionExpiryScheduler ||
    require('./subscriptionExpiryScheduler').startSubscriptionExpiryScheduler;
  const startDailyCoaching =
    dependencies.startDailyCoaching || require('./scheduler').startDailyCoaching;
  const startReminderScheduler =
    dependencies.startReminderScheduler ||
    require('./reminderScheduler').startReminderScheduler;
  const logger = dependencies.logger || console;

  const schedulers = [];
  let stopped = false;
  let schedulersStarted = false;

  const stopSchedulers = (message) => {
    for (const scheduler of schedulers.reverse()) {
      try {
        scheduler?.stop?.();
      } catch (err) {
        logger.error(message, err.message);
      }
    }
  };

  const startSchedulers = () => {
    if (stopped || schedulersStarted) return;
    schedulersStarted = true;
    try {
      schedulers.push(startSubscriptionExpiryScheduler());
      schedulers.push(startDailyCoaching(bot));
      schedulers.push(startReminderScheduler(bot));
    } catch (err) {
      stopSchedulers('Failed to stop partially started scheduler:');
      throw err;
    }
  };

  // Telegraf calls this callback after it has validated the bot identity, but
  // before long polling begins. This avoids starting paid/local background work
  // for an invalid token while still avoiding the never-resolving poll await.
  const launchPromise = Promise.resolve(bot.launch({}, startSchedulers));

  return {
    launchPromise,
    stop() {
      if (stopped) return;
      stopped = true;
      stopSchedulers('Failed to stop scheduler:');
    },
  };
}

module.exports = { startBotRuntime };
