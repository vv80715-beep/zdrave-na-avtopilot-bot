'use strict';

const API_BASE_URL = (import.meta.env?.VITE_SUPABASE_URL || '')
  ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api`
  : '';

const params = new URLSearchParams(window.location.search);
const checkoutSessionId = (params.get('checkout_session_id') || '').trim();
const card = document.querySelector('[data-result-state]');
const retryButton = document.querySelector('[data-result-retry]');
const telegramButton = document.querySelector('[data-result-telegram]');
let timer = null;
let attempts = 0;
let checking = false;
let currentState = 'checking';
let currentData = {};

function getLang() { return window.elizdraveI18n ? window.elizdraveI18n.getLang() : 'bg'; }
function L(field) { if (typeof field === 'string') return field; if (field && typeof field === 'object') return field[getLang()] || field.bg || ''; return ''; }

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(getLang() === 'en' ? 'en-GB' : 'bg-BG', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const statusTexts = {
  active: {
    label: { bg: 'ПОТВЪРДЕНО SERVER-SIDE', en: 'CONFIRMED SERVER-SIDE' },
    title: { bg: 'Готово. Планът ти е активиран.', en: 'Done. Your plan is activated.' },
    copy: { bg: 'Провереният Stripe webhook е записал плащането и Premium entitlement-а. EliZdraveBot вече може да прочете активния план от backend-а.', en: 'The verified Stripe webhook has recorded the payment and Premium entitlement. EliZdraveBot can now read the active plan from the backend.' },
    payment: 'PAID',
    entitlement: 'ACTIVE',
    help: { bg: 'Отвори Ели в Telegram. Deep link-ът кара бота да поиска нова server-side проверка, преди да покаже активните режими.', en: 'Open Eli in Telegram. The deep link makes the bot request a new server-side check before showing active modes.' },
  },
  pending: {
    label: { bg: 'WEBHOOK СЕ ОБРАБОТВА', en: 'WEBHOOK PROCESSING' },
    title: { bg: 'Плащането още се потвърждава.', en: 'Payment is still being confirmed.' },
    copy: { bg: 'Не даваме Premium само защото браузърът се е върнал от Stripe. Backend-ът ще завърши обработката след проверен webhook.', en: 'We don\'t grant Premium just because the browser returned from Stripe. The backend will finish processing after a verified webhook.' },
    payment: 'PENDING',
    entitlement: 'WAITING',
    help: { bg: 'Можеш да се върнеш в EliZdraveBot и да провериш плана след малко.', en: 'You can return to EliZdraveBot and check the plan shortly.' },
  },
  failed: {
    label: { bg: 'ПЛАЩАНЕТО НЕ Е ЗАВЪРШЕНО', en: 'PAYMENT NOT COMPLETED' },
    title: { bg: 'Premium не е активиран.', en: 'Premium not activated.' },
    copy: { bg: 'Backend-ът не вижда потвърдено успешно плащане. Frontend-ът не може да даде достъп.', en: 'The backend sees no confirmed successful payment. The frontend cannot grant access.' },
    help: { bg: 'Върни се в EliZdraveBot и поискай нов защитен линк, когато си готов.', en: 'Return to EliZdraveBot and request a new secure link when ready.' },
  },
  invalid: {
    label: { bg: 'НЕВАЛИДНА СЕСИЯ', en: 'INVALID SESSION' },
    title: { bg: 'Не можем да проверим това плащане.', en: 'We cannot verify this payment.' },
    copy: { bg: 'В адреса липсва валиден Stripe Checkout Session ID. Не са дадени Premium права.', en: 'The address is missing a valid Stripe Checkout Session ID. No Premium rights granted.' },
    plan: '—',
    payment: 'UNKNOWN',
    entitlement: 'BLOCKED',
    help: { bg: 'Отвори EliZdraveBot и използвай защитения линк от разговора.', en: 'Open EliZdraveBot and use the secure link from the conversation.' },
  },
  checking: {
    label: { bg: 'WEBHOOK ПРОВЕРКА', en: 'WEBHOOK CHECK' },
    title: { bg: 'Плащането се обработва.', en: 'Payment is being processed.' },
    copy: { bg: 'Stripe Checkout е приключил, но изчакваме проверения server-side webhook и entitlement записа.', en: 'Stripe Checkout has finished, but we\'re waiting for the verified server-side webhook and entitlement record.' },
    help: { bg: 'Не презареждай многократно — страницата проверява автоматично.', en: 'Don\'t reload repeatedly — the page checks automatically.' },
  },
  unavailable: {
    label: { bg: 'ВРЕМЕННО НЕДОСТЪПНО', en: 'TEMPORARILY UNAVAILABLE' },
    title: { bg: 'Не успяхме да проверим статуса.', en: 'Could not check the status.' },
    copy: { bg: 'Това не променя плащането. Premium ще се активира само ако backend-ът получи и провери Stripe webhook-а.', en: 'This doesn\'t change the payment. Premium will activate only if the backend receives and verifies the Stripe webhook.' },
    payment: 'CHECK LATER',
    entitlement: 'UNKNOWN',
    help: { bg: 'Опитай отново или се върни в EliZdraveBot след малко.', en: 'Try again or return to EliZdraveBot shortly.' },
  },
};

function renderState(state, data = {}) {
  currentState = state;
  currentData = data;
  if (card) card.dataset.resultState = state;
  setText('[data-result-label]', data.label || '');
  setText('[data-result-title]', data.title || '');
  setText('[data-result-copy]', data.copy || '');
  setText('[data-result-plan]', data.plan || '');
  setText('[data-result-payment]', data.payment || '');
  setText('[data-result-entitlement]', data.entitlement || '');
  setText('[data-result-until]', data.until || '—');
  setText('[data-result-help]', data.help || '');
  if (telegramButton) telegramButton.hidden = state !== 'active';
}

function applyCurrentState() {
  const s = statusTexts[currentState];
  if (!s) return;
  const lang = getLang();
  const data = currentData;
  renderState(currentState, {
    label: L(s.label),
    title: L(s.title),
    copy: L(s.copy) || data.copy,
    plan: data.plan || (s.plan ? L(s.plan) : (lang === 'en' ? 'Checking…' : 'Проверка…')),
    payment: data.payment || s.payment || '',
    entitlement: data.entitlement || s.entitlement || '',
    until: data.until || '—',
    help: L(s.help) || data.help,
  });
}

function scheduleNext() {
  clearTimeout(timer);
  if (attempts >= 20) {
    renderState('pending', {});
    applyCurrentState();
    return;
  }
  timer = setTimeout(checkStatus, 1500);
}

async function checkStatus() {
  if (checking) return;
  if (!/^cs_[A-Za-z0-9_]+$/.test(checkoutSessionId)) {
    renderState('error', {});
    currentState = 'invalid';
    applyCurrentState();
    return;
  }

  checking = true;
  attempts += 1;
  if (retryButton) retryButton.disabled = true;

  try {
    const response = await fetch(`${API_BASE_URL}/checkout-sessions/${encodeURIComponent(checkoutSessionId)}/status`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || 'Status lookup failed');

    if (payload.state === 'paid' && payload.entitlement_status === 'active') {
      renderState('active', {
        plan: payload.plan?.name || '',
        payment: 'PAID',
        entitlement: 'ACTIVE',
        until: formatDate(payload.access_expires_at),
      });
      applyCurrentState();
      clearTimeout(timer);
      return;
    }

    if (['failed', 'cancelled', 'expired'].includes(payload.state)) {
      renderState('error', {
        plan: payload.plan?.name || '—',
        payment: String(payload.payment_status || payload.state).toUpperCase(),
        entitlement: String(payload.entitlement_status || 'INACTIVE').toUpperCase(),
        until: payload.access_expires_at ? formatDate(payload.access_expires_at) : '—',
      });
      currentState = 'failed';
      applyCurrentState();
      return;
    }

    renderState('checking', {
      plan: payload.plan?.name || '',
      payment: String(payload.payment_status || 'PENDING').toUpperCase(),
      entitlement: String(payload.entitlement_status || 'WAITING').toUpperCase(),
      until: payload.access_expires_at ? formatDate(payload.access_expires_at) : '—',
    });
    applyCurrentState();
    scheduleNext();
  } catch (error) {
    console.error('Payment status check failed:', error);
    renderState('pending', {});
    currentState = 'unavailable';
    applyCurrentState();
    scheduleNext();
  } finally {
    checking = false;
    if (retryButton) retryButton.disabled = false;
  }
}

if (retryButton) retryButton.addEventListener('click', () => {
  attempts = 0;
  checkStatus();
});

window.addEventListener('langchange', () => {
  if (currentData.until) currentData.until = currentData.until;
  applyCurrentState();
});

checkStatus();
