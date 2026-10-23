function listenForHealthServer(app, port) {
  return new Promise((resolve, reject) => {
    let server;
    try {
      server = app.listen(port);
    } catch (error) {
      reject(error);
      return;
    }

    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server);
    };
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

function startBotRuntimeWithHealthServer(bot, app, port, dependencies = {}) {
  return listenForHealthServer(app, port).then(async (server) => {
    let runtime;
    try {
      // The occupied health port is the local singleton guard. Do not create a
      // Telegram poller until this process owns the configured listener.
      await dependencies.beforePolling?.();
      runtime = startBotRuntime(bot, dependencies);
    } catch (error) {
      if (server.listening) server.close();
      throw error;
    }

    let stopped = false;
    return {
      ...runtime,
      server,
      stop() {
        if (stopped) return;
        stopped = true;
        runtime.stop();
        if (server.listening) server.close();
      },
    };
  });
}

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

module.exports = {
  listenForHealthServer,
  startBotRuntime,
  startBotRuntimeWithHealthServer,
};
