'use strict';

export const CHECKOUT_NOT_CONFIGURED_MESSAGE = 'Checkout временно не е конфигуриран.';

function apiBaseFromEnv() {
  // Must match the purchase-session authority used by the existing Telegram bot.
  // A stale frontend environment cannot select another session database.
  return 'https://aoaylzncorwakxcactox.supabase.co/functions/v1/api';
}

export function getCheckoutApiBaseUrl() {
  return apiBaseFromEnv();
}

export function getPurchaseSessionToken(search = window.location.search) {
  return (new URLSearchParams(search).get('session') || '').trim();
}

export function preservePurchaseSessionLinks(documentRef = document, pageUrl = window.location.href) {
  const current = new URL(pageUrl);
  const token = getPurchaseSessionToken(current.search);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) return;
  for (const link of documentRef.querySelectorAll('a[href]')) {
    const target = new URL(link.getAttribute('href'), current);
    if (target.origin !== current.origin ||
        !/\/(?:index|seven-day|monthly|yearly|confirm-plan)\.html$/.test(target.pathname)) continue;
    // The token is opaque. The destination must still verify its stored plan;
    // neither the page name nor a client plan parameter is payment authority.
    target.searchParams.delete('plan');
    target.searchParams.set('session', token);
    link.setAttribute('href', `${target.pathname}${target.search}${target.hash}`);
  }
}

function errorCode(payload) {
  const raw = payload?.error ?? payload?.code ?? payload?.error_code;
  if (raw && typeof raw === 'object') {
    return String(raw.code || raw.error || '').trim().toLowerCase();
  }
  return String(raw || '').trim().toLowerCase();
}

export function isCheckoutNotConfigured(payload) {
  return errorCode(payload) === 'checkout_not_configured';
}

export function extractBackendCheckoutUrl(payload) {
  if (!payload || typeof payload.checkout_url !== 'string' || !payload.checkout_url.trim()) return null;

  let checkoutUrl;
  try {
    checkoutUrl = new URL(payload.checkout_url);
  } catch {
    return null;
  }

  if (checkoutUrl.protocol !== 'https:' || checkoutUrl.username || checkoutUrl.password) return null;
  return checkoutUrl.toString();
}

function backendMessage(payload, fallback) {
  return typeof payload?.message === 'string' && payload.message.trim()
    ? payload.message.trim()
    : fallback;
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

export async function verifyPurchaseSession({
  fetchImpl = fetch,
  apiBaseUrl = getCheckoutApiBaseUrl(),
  sessionToken,
} = {}) {
  const token = String(sessionToken || '').trim();
  if (!token) {
    return { ok: false, code: 'missing_session', message: 'Няма свързана checkout сесия.' };
  }

  const response = await fetchImpl(
    `${apiBaseUrl}/purchase-sessions/${encodeURIComponent(token)}`,
    {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
    },
  );
  const payload = await readJson(response);
  return {
    ok: response.ok,
    status: response.status,
    payload,
    code: errorCode(payload),
    message: backendMessage(payload, 'Сесията не е валидна.'),
  };
}

export async function requestCheckout({
  fetchImpl = fetch,
  apiBaseUrl = getCheckoutApiBaseUrl(),
  sessionToken,
} = {}) {
  const token = String(sessionToken || '').trim();
  if (!token) {
    return { ok: false, code: 'missing_session', message: 'Няма свързана checkout сесия.' };
  }

  const response = await fetchImpl(
    `${apiBaseUrl}/purchase-sessions/${encodeURIComponent(token)}/checkout`,
    {
      method: 'POST',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
    },
  );
  const payload = await readJson(response);

  if (isCheckoutNotConfigured(payload)) {
    return {
      ok: false,
      status: response.status,
      code: 'checkout_not_configured',
      message: CHECKOUT_NOT_CONFIGURED_MESSAGE,
      payload,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      code: errorCode(payload) || 'checkout_error',
      message: backendMessage(payload, 'Checkout заявката не успя.'),
      payload,
    };
  }

  const checkoutUrl = extractBackendCheckoutUrl(payload);
  if (!checkoutUrl) {
    return {
      ok: false,
      status: response.status,
      code: 'invalid_checkout_url',
      message: 'Backend-ът върна невалиден checkout URL.',
      payload,
    };
  }

  return { ok: true, status: response.status, checkout_url: checkoutUrl, payload };
}

export function redirectToBackendCheckout(result, navigate = (url) => window.location.assign(url)) {
  if (!result?.ok) return result;
  const checkoutUrl = extractBackendCheckoutUrl({ checkout_url: result.checkout_url });
  if (!checkoutUrl) {
    return {
      ok: false,
      code: 'invalid_checkout_url',
      message: 'Backend-ът върна невалиден checkout URL.',
    };
  }
  navigate(checkoutUrl);
  return { ok: true, checkout_url: checkoutUrl };
}