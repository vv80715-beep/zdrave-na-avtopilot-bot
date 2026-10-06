// Independent, pinned quota boundary. Neither site origin nor payment endpoint
// configuration may redirect a credential-bearing metering request.
const URL = 'https://aoaylzncorwakxcactox.supabase.co/functions/v1/avatar-metering';

async function meterAvatar(action, userId, requestId, extra = {}, fetchFn = global.fetch, secret = process.env.BOT_PURCHASE_API_SECRET) {
  if (typeof secret !== 'string' || secret.trim().length < 32 ||
      secret === 'replace-with-at-least-32-random-characters') throw new Error('avatar_metering_unavailable');
  if (!['allowance', 'reserve', 'get', 'begin', 'job', 'uncertain', 'failed', 'complete', 'pending'].includes(action) ||
      (action === 'reserve' && Object.hasOwn(extra, 'hold_seconds')) ||
      !/^[1-9]\d{4,18}$/.test(String(userId)) ||
      requestId !== `tg:${userId}:${requestId?.split(':')[2]}` ||
      !/^tg:[1-9]\d{4,18}:[1-9]\d{0,18}$/.test(requestId))
    throw new Error('avatar_metering_invalid_input');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  timeout.unref?.();
  try {
    const response = await fetchFn(URL, {
      method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action, telegram_user_id: String(userId), request_id: requestId, ...extra }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 403 && typeof response.json === 'function') {
        let denied;
        try { denied = await response.json(); } catch (_) {}
        if (denied?.error === 'avatar_quota_exceeded' ||
            denied?.error === 'avatar_pending_reconciliation') {
          const error = new Error(denied.error);
          error.code = denied.error;
          throw error;
        }
      }
      throw new Error('avatar_metering_denied');
    }
    const body = await response.json();
    if (!body || typeof body !== 'object' ||
        !['eligible', 'exhausted', 'reserved', 'submitting', 'submitted', 'settled', 'failed', 'uncertain', 'none'].includes(body.status) ||
        (['eligible','exhausted'].includes(body.status) &&
          (action !== 'allowance' || !Number.isSafeInteger(body.available_seconds) ||
          body.available_seconds < 0)) ||
        (body.status === 'none' && action !== 'pending') ||
        (!['none','eligible','exhausted'].includes(body.status) && body.hold_seconds !== 30) ||
        (body.status === 'submitted' && !/^[A-Za-z0-9_-]{8,200}$/.test(body.video_id || '')))
      throw new Error('avatar_metering_invalid_response');
    return body;
  } finally { clearTimeout(timeout); }
}

module.exports = { meterAvatar };