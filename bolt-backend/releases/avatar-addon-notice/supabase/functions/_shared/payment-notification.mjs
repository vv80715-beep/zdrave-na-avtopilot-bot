/** Deterministic after-payment delivery; no LLM, checkout creation or access grants. */
import { AVATAR_ADDON_EVENT, buildAvatarAddonNotification } from './avatar-addon-notification.mjs';
export const AFTERCARE_VERSION = '2026-09-18-v1';
export const ELI_BOT_USERNAME = 'EliZdraveBot';
export const DEFAULT_SITE_ORIGIN = 'https://zdrave-na-avtopilot-dkr6.bolt.host';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLANS = Object.freeze({
  seven_day: { label: '7-дневният план', modes: 'текст, глас и Общност' },
  monthly: { label: 'Месечният план', modes: 'текст, глас, Avatar видео и Общност' },
  yearly: { label: 'Годишният план', modes: 'текст, глас, Avatar видео и Общност' },
});
export function isUuid(value) { return typeof value === 'string' && UUID.test(value); }

export function communityUrlFor(siteOrigin = DEFAULT_SITE_ORIGIN) {
  const url = new URL(siteOrigin);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')) throw new Error('invalid_site_origin');
  return new URL('/community.html', url.origin).href;
}

export function readBotToken(getEnv) {
  const token = getEnv('TELEGRAM_BOT_TOKEN') || getEnv('BOT_TOKEN') || getEnv('TELEGRAM_TOKEN') || '';
  return /^[0-9]{5,20}:[A-Za-z0-9_-]{20,}$/.test(token) ? token : null;
}

export function buildPaymentNotification(event, { siteOrigin = DEFAULT_SITE_ORIGIN, now = Date.now() } = {}) {
  if (event?.event_type === AVATAR_ADDON_EVENT) return buildAvatarAddonNotification(event, { now });
  const plan = Object.hasOwn(PLANS, event?.plan_id) ? PLANS[event.plan_id] : null;
  const chatId = String(event?.telegram_user_id ?? '');
  const expiresAt = Date.parse(event?.access_expires_at);
  const paidAt = Date.parse(event?.paid_at);
  if (!plan || event?.event_type !== 'payment_confirmed_plan_activated' || event.status !== 'sending'
      || !isUuid(event.id) || !isUuid(event.payment_id) || !isUuid(event.purchase_session_id)
      || !/^[1-9][0-9]{4,15}$/.test(chatId) || !Number.isSafeInteger(Number(chatId))
      || event.amount_cents !== 100 || event.currency !== 'eur'
      || !Number.isFinite(paidAt) || paidAt > now + 60000
      || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt <= paidAt) {
    throw new Error('invalid_verified_payment_event');
  }
  const expiry = new Intl.DateTimeFormat('bg-BG', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Sofia',
  }).format(new Date(expiresAt));
  return {
    chat_id: chatId,
    text: [
      'Плащането ти от 1 € е потвърдено.',
      `${plan.label} е активен до ${expiry} (българско време).`,
      `Включен достъп: ${plan.modes}.`,
      '',
      'Добре дошъл в „Здраве на автопилот“! Аз съм Ели и ще ти помагам стъпка по стъпка.',
      'Отвори Общността от бутона по-долу и влез с профила, свързан с твоя Telegram.',
      'С /mode можеш да избереш как да общуваш с мен.',
    ].join('\n'),
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: 'Отвори Общността', url: communityUrlFor(siteOrigin) }]] },
  };
}

export async function expectedBot(token, fetchImpl = fetch) {
  if (!token) return false;
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    const body = await response.json();
    return response.ok && body?.ok === true && body.result?.is_bot === true
      && body.result.username === ELI_BOT_USERNAME;
  } catch { return false; }
}

/** store.claim is an atomic database lease; store.finish matches both id and lease. */
export async function dispatchPaymentNotification({ eventId, store, botToken, siteOrigin, fetchImpl = fetch, now = Date.now() }) {
  if (!isUuid(eventId)) throw new Error('invalid_notification_event_id');
  if (!botToken) return { status: 'pending', error_code: 'telegram_not_configured' };
  // Never send from an accidentally configured different bot.
  if (!await expectedBot(botToken, fetchImpl)) return { status: 'pending', error_code: 'eli_bot_identity_not_verified' };
  const event = await store.claim(eventId);
  if (!event) return { status: await store.status(eventId), delivered_now: false };
  let message;
  try { message = buildPaymentNotification(event, { siteOrigin, now }); }
  catch {
    await store.finish(event, { status: 'failed', error_code: 'invalid_verified_payment_event' });
    return { status: 'failed', error_code: 'invalid_verified_payment_event' };
  }
  let outcome;
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message), redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    if (response.ok && body?.ok === true && Number.isSafeInteger(body.result?.message_id)
        && body.result.message_id > 0 && String(body.result.chat?.id) === message.chat_id) {
      outcome = { status: 'sent', message_id: body.result.message_id };
    } else if (body?.ok === false && response.status < 500 && body.error_code === 429) {
      const seconds = Number(body.parameters?.retry_after);
      outcome = {
        status: event.attempts >= 5 ? 'failed' : 'retry', error_code: 'telegram_rate_limited',
        retry_after_seconds: Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds, 86400) : 60,
      };
    } else if (body?.ok === false && response.status < 500 && [400,401,403,404].includes(body.error_code)) {
      outcome = { status: 'failed', error_code: 'telegram_rejected_' + body.error_code };
    } else {
      outcome = { status: 'uncertain', error_code: 'delivery_outcome_unknown' };
    }
  } catch {
    // A timeout may happen AFTER Telegram accepted the message. Do not double-send.
    outcome = { status: 'uncertain', error_code: 'delivery_outcome_unknown' };
  }
  try { await store.finish(event, outcome); }
  catch { return { status: 'uncertain', error_code: 'notification_ack_failed' }; }
  return { status: outcome.status, error_code: outcome.error_code || null, delivered_now: outcome.status === 'sent' };
}
