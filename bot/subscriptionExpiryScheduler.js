const EXPIRY_WORKER_URL =
  'https://aoaylzncorwakxcactox.supabase.co/functions/v1/subscription-expiry';
const TICK_MS = 60 * 1000;
const TIMEOUT_MS = 50 * 1000;

// Only the remote worker touches expiry state and its durable delivery outbox.
// This process supplies a periodic wake-up, not a local delivery queue.
function startSubscriptionExpiryScheduler({
  fetchFn = global.fetch,
  env = process.env,
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const secret = env?.BOT_PURCHASE_API_SECRET;
  if (typeof secret !== 'string' || secret.trim().length < 32) {
    logger.warn('Subscription expiry scheduler disabled: invalid secret.');
    return { stop() {} };
  }
  if (typeof fetchFn !== 'function') {
    logger.warn('Subscription expiry scheduler disabled: fetch unavailable.');
    return { stop() {} };
  }

  let stopped = false;
  let inFlight = false;
  let controller = null;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    controller = new AbortController();
    const currentController = controller;
    const timeout = setTimeoutFn(() => currentController.abort(), TIMEOUT_MS);
    timeout?.unref?.();
    try {
      const response = await fetchFn(EXPIRY_WORKER_URL, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${secret.trim()}`,
          Accept: 'application/json',
        },
        signal: currentController.signal,
      });
      if (stopped) return;
      if (currentController.signal.aborted) {
        logger.warn('Subscription expiry worker request failed: timeout.');
      } else if (!response || response.ok !== true) {
        // Never include response bodies, URLs, headers, or error objects in logs.
        logger.warn('Subscription expiry worker request failed: http_error.');
      }
    } catch (_) {
      if (!stopped) {
        logger.warn(
          `Subscription expiry worker request failed: ${currentController.signal.aborted ? 'timeout' : 'network_error'}.`
        );
      }
    } finally {
      clearTimeoutFn(timeout);
      controller = null;
      inFlight = false;
    }
  };

  // Start after one minute; errors are handled in tick and the next interval retries.
  const interval = setIntervalFn(tick, TICK_MS);
  interval?.unref?.();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(interval);
      controller?.abort();
    },
  };
}

module.exports = { startSubscriptionExpiryScheduler };