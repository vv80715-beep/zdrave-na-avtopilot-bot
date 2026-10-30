'use strict';
import {
  CHECKOUT_NOT_CONFIGURED_MESSAGE,
  getCheckoutApiBaseUrl,
  getPurchaseSessionToken,
  redirectToBackendCheckout,
  requestCheckout,
  verifyPurchaseSession,
} from './checkout-routing.js';

let verifiedSessionToken = '';
let checkoutInFlight = false;

const API_BASE_URL = getCheckoutApiBaseUrl();

function configurePaymentButton({ enabled, label } = {}) {
  const button = document.querySelector('[data-payment-button]');
  if (!button) return;
  button.disabled = !enabled;
  button.setAttribute('aria-disabled', String(!enabled));
  if (label) button.innerHTML = `${label} <span aria-hidden="true">→</span>`;
}

async function startCheckout() {
  if (!verifiedSessionToken || checkoutInFlight) return;
  checkoutInFlight = true;
  configurePaymentButton({ enabled: false, label: tr(ui.checkoutCreating.buttonLabel) });
  text('[data-payment-status]', ui.checkoutCreating.paymentStatus);
  text('[data-payment-help]', tr(ui.checkoutCreating.paymentHelp));

  try {
    const result = await requestCheckout({
      apiBaseUrl: API_BASE_URL,
      sessionToken: verifiedSessionToken,
    });
    if (!result.ok) {
      if (result.code === 'checkout_not_configured') {
        currentSessionState = 'checkoutNotConfigured';
        applySessionState('checkoutNotConfigured');
        return;
      }
      if (result.code === 'test_checkout_forbidden') {
        currentSessionState = 'testCheckoutForbidden';
        applySessionState('testCheckoutForbidden');
        return;
      }
      throw new Error(result.message || 'Checkout заявката не успя.');
    }
    const redirect = redirectToBackendCheckout(result);
    if (!redirect.ok) throw new Error(redirect.message);
  } catch (error) {
    console.error('Checkout start failed:', error);
    currentSessionState = 'checkoutError';
    applySessionState('checkoutError');
    configurePaymentButton({ enabled: true, label: tr(ui.checkoutError.buttonLabel) });
  } finally {
    checkoutInFlight = false;
  }
}

const planCatalog = {
  seven_day: {
    aliases: ['seven_day', 'seven-day', '7-day'],
    name: { bg: '7 дни с Ели', en: '7 days with Eli' },
    shortName: { bg: '7 дни', en: '7 days' },
    badge: { bg: '7 ДНИ', en: '7 DAYS' },
    price: '€15',
    period: { bg: 'еднократно / 7 дни', en: 'one-time / 7 days' },
    description: {
      bg: '7 дни Premium достъп до Ели с Text, Voice и пълен Community достъп. Avatar не е включен.',
      en: '7 days Premium access to Eli with Text, Voice, and full Community access. Avatar not included.',
    },
    page: 'seven-day.html',
    expiry: {
      bg: '<strong>При изтичане:</strong> Premium се заключва, но профилът, историята и прогресът ти се запазват. Не се дава втори Free Trial.',
      en: '<strong>At expiry:</strong> Premium locks, but your profile, history, and progress are preserved. No second Free Trial.',
    },
    features: [
      ['TEXT', { bg: 'Ежедневни разговори и персонализирана подкрепа.', en: 'Daily conversations and personalized support.' }, true],
      ['VOICE', { bg: 'Гласови съобщения и гласови отговори.', en: 'Voice messages and voice replies.' }, true],
      ['AVATAR', { bg: 'Не е включен в 7-дневния план.', en: 'Not included in the 7-day plan.' }, false],
      ['COMMUNITY', { bg: 'Пълен достъп до V1 общността.', en: 'Full access to the V1 community.' }, true],
    ],
    summary: [
      ['TEXT', { bg: 'Включен', en: 'Included' }],
      ['VOICE', { bg: 'Включен', en: 'Included' }],
      ['AVATAR', { bg: 'Не е включен', en: 'Not included' }],
      ['COMMUNITY', { bg: 'Пълен достъп', en: 'Full access' }],
    ],
  },
  monthly: {
    aliases: ['monthly', 'month', '1-month'],
    name: { bg: '1 месец с Ели', en: '1 month with Eli' },
    shortName: { bg: '1 месец', en: '1 month' },
    badge: { bg: '1 МЕСЕЦ', en: '1 MONTH' },
    price: '€50',
    period: { bg: '/ месец', en: '/ month' },
    description: {
      bg: 'Пълният месечен достъп до Ели с Text, Voice, Community и до 30 минути Avatar видео.',
      en: 'The full monthly access to Eli with Text, Voice, Community, and up to 30 minutes Avatar video.',
    },
    page: 'monthly.html',
    expiry: {
      bg: '<strong>При изтичане:</strong> Premium функциите се заключват, но профилът, историята и прогресът ти се запазват. Допълнително закупените Avatar минути остават записани, но заключени.',
      en: '<strong>At expiry:</strong> Premium features lock, but your profile, history, and progress are preserved. Extra purchased Avatar minutes remain recorded but locked.',
    },
    features: [
      ['TEXT', { bg: 'Ежедневни разговори и персонализирана подкрепа.', en: 'Daily conversations and personalized support.' }, true],
      ['VOICE', { bg: 'Гласови съобщения и гласови отговори.', en: 'Voice messages and voice replies.' }, true],
      ['AVATAR', { bg: 'До 30 минути генерирано Avatar видео месечно.', en: 'Up to 30 minutes of generated Avatar video monthly.' }, true],
      ['COMMUNITY', { bg: 'Пълен достъп до V1 общността.', en: 'Full access to the V1 community.' }, true],
    ],
    summary: [
      ['TEXT', { bg: 'Включен', en: 'Included' }],
      ['VOICE', { bg: 'Включен', en: 'Included' }],
      ['AVATAR', { bg: 'До 30 мин./месец', en: 'Up to 30 min./month' }],
      ['COMMUNITY', { bg: 'Пълен достъп', en: 'Full access' }],
    ],
  },
  yearly: {
    aliases: ['yearly', 'year', '1-year'],
    name: { bg: '1 година с Ели', en: '1 year with Eli' },
    shortName: { bg: '1 година', en: '1 year' },
    badge: { bg: '1 ГОДИНА', en: '1 YEAR' },
    price: '€360',
    period: { bg: '/ година', en: '/ year' },
    description: {
      bg: 'Годишният Premium достъп до Ели с Text, Voice, Community и 20 минути Avatar всеки месец за 12 месеца.',
      en: 'The yearly Premium access to Eli with Text, Voice, Community, and 20 Avatar minutes every month for 12 months.',
    },
    page: 'yearly.html',
    expiry: {
      bg: '<strong>При изтичане:</strong> Premium се заключва, но профилът, историята и прогресът ти се запазват. Avatar лимитът се зарежда всеки месец, а не целият годишен баланс наведнъж.',
      en: '<strong>At expiry:</strong> Premium locks, but your profile, history, and progress are preserved. The Avatar limit reloads monthly, not the entire yearly balance at once.',
    },
    features: [
      ['TEXT', { bg: 'Ежедневни разговори и персонализирана подкрепа.', en: 'Daily conversations and personalized support.' }, true],
      ['VOICE', { bg: 'Гласови съобщения и гласови отговори.', en: 'Voice messages and voice replies.' }, true],
      ['AVATAR', { bg: '20 минути Avatar всеки месец × 12.', en: '20 Avatar minutes every month × 12.' }, true],
      ['COMMUNITY', { bg: 'Пълен достъп до V1 общността.', en: 'Full access to the V1 community.' }, true],
    ],
    summary: [
      ['TEXT', { bg: 'Включен', en: 'Included' }],
      ['VOICE', { bg: 'Включен', en: 'Included' }],
      ['AVATAR', { bg: '20 мин./месец × 12', en: '20 min./month × 12' }],
      ['COMMUNITY', { bg: 'Пълен достъп', en: 'Full access' }],
    ],
  },
};

function resolvePlan(rawPlan) {
  const normalized = String(rawPlan || '').trim().toLowerCase();
  const entry = Object.entries(planCatalog).find(([, plan]) => plan.aliases.includes(normalized));
  return entry || [null, null];
}

function text(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function L(field, lang) {
  if (typeof field === 'string') return field;
  if (field && typeof field === 'object') return field[lang] || field.bg || '';
  return '';
}

function renderFeatureRows(selector, rows, detailed = false) {
  const container = document.querySelector(selector);
  if (!container) return;
  const lang = window.elizdraveI18n ? window.elizdraveI18n.getLang() : 'bg';
  const enabledLabel = lang === 'en' ? 'Included' : 'Включено';
  const disabledLabel = lang === 'en' ? 'Not included' : 'Не е включено';

  container.innerHTML = rows.map((row) => {
    if (!detailed) {
      return `<div><span>${row[0]}</span><strong>${L(row[1], lang)}</strong></div>`;
    }

    const enabled = row[2];
    return `<div class="${enabled ? '' : 'feature-off'}"><span>${row[0]}</span><p>${L(row[1], lang)}</p><strong aria-label="${enabled ? enabledLabel : disabledLabel}">${enabled ? '✓' : '—'}</strong></div>`;
  }).join('');
}

function renderPlan(planId) {
  const plan = planCatalog[planId];
  if (!plan) return null;
  const lang = window.elizdraveI18n ? window.elizdraveI18n.getLang() : 'bg';

  text('[data-plan-badge]', L(plan.badge, lang));
  text('[data-plan-name]', L(plan.name, lang));
  text('[data-plan-price]', plan.price);
  text('[data-plan-period]', L(plan.period, lang));
  text('[data-plan-total]', plan.price);
  text('[data-plan-description]', L(plan.description, lang));
  text('[data-payment-plan]', L(plan.shortName, lang));
  text('[data-payment-price]', plan.price);

  renderFeatureRows('[data-plan-features]', plan.summary, false);
  renderFeatureRows('[data-confirm-features]', plan.features, true);

  const expiry = document.querySelector('[data-expiry-copy]');
  if (expiry) expiry.innerHTML = L(plan.expiry, lang);

  const backLink = document.querySelector('[data-plan-back]');
  if (backLink) backLink.href = plan.page;

  const telegramButton = document.querySelector('[data-telegram-connect]');
  if (telegramButton) telegramButton.href = `https://t.me/EliZdraveBot?start=buy_${planId}`;

  document.documentElement.dataset.plan = planId;
  return plan;
}

function showSessionCode(session) {
  const preview = document.querySelector('[data-session-preview]');
  const code = document.querySelector('[data-session-code]');
  if (preview) preview.hidden = false;
  if (code) code.textContent = `••••••••${session.slice(-6)}`;
}

function setSessionState(state, { title, badge, copy, telegram, paymentStatus, paymentHelp } = {}) {
  const panel = document.querySelector('.telegram-status');
  if (panel) panel.setAttribute('data-session-state', state);
  if (title) text('[data-session-title]', title);
  if (badge) text('[data-session-badge]', badge);
  if (copy) text('[data-session-copy]', copy);
  if (telegram) text('[data-payment-telegram]', telegram);
  if (paymentStatus) text('[data-payment-status]', paymentStatus);
  if (paymentHelp) text('[data-payment-help]', paymentHelp);
}

const ui = {
  checking: {
    title: { bg: 'Проверяваме защитената сесия…', en: 'Verifying the secure session…' },
    badge: { bg: 'ПРОВЕРКА', en: 'CHECKING' },
    copy: { bg: 'Backend-ът проверява еднократната сесия. Данните за потребителя, плана и цената не се приемат от браузъра.', en: 'The backend verifies the one-time session. User, plan, and price data are not accepted from the browser.' },
    telegram: { bg: 'Проверка…', en: 'Checking…' },
    paymentStatus: 'SESSION CHECK',
  },
  expired: {
    title: { bg: 'Сесията е изтекла', en: 'Session expired' },
    badge: { bg: 'ИЗТЕКЛА', en: 'EXPIRED' },
    copy: { bg: 'Защитният линк е краткоживеещ. Отвори EliZdraveBot и поискай нов линк за покупката.', en: 'The secure link is short-lived. Open EliZdraveBot and request a new purchase link.' },
    telegram: { bg: 'Нужна е нова сесия', en: 'New session needed' },
    paymentStatus: 'BLOCKED',
    paymentHelp: { bg: 'Отвори EliZdraveBot и поискай нов защитен линк за избрания план.', en: 'Open EliZdraveBot and request a new secure link for the selected plan.' },
    buttonLabel: { bg: 'Нужна е нова сесия', en: 'New session needed' },
  },
  invalid: {
    title: { bg: 'Сесията не е валидна', en: 'Session is not valid' },
    badge: { bg: 'НЕВАЛИДНА', en: 'INVALID' },
    copy: { bg: 'Backend-ът не потвърди тази сесия. Premium няма да бъде отключен и плащане няма да започне.', en: 'The backend did not confirm this session. Premium will not be unlocked and no payment will start.' },
    telegram: { bg: 'Нужна е нова сесия', en: 'New session needed' },
    paymentStatus: 'BLOCKED',
    paymentHelp: { bg: 'Отвори EliZdraveBot и поискай нов защитен линк за избрания план.', en: 'Open EliZdraveBot and request a new secure link for the selected plan.' },
    buttonLabel: { bg: 'Нужна е нова сесия', en: 'New session needed' },
  },
  verified: {
    title: { bg: 'Сесията е валидна и свързана', en: 'Session is valid and linked' },
    badge: { bg: 'ВЕРИФИЦИРАНА', en: 'VERIFIED' },
    telegram: { bg: 'Свързано защитено', en: 'Securely linked' },
    paymentStatus: 'READY',
    paymentHelp: { bg: 'Stripe Checkout ще се създаде само от server-side плана и тази сесия.', en: 'Stripe Checkout will be created only from the server-side plan and this session.' },
    buttonLabel: { bg: 'Продължи към сигурно плащане', en: 'Continue to secure payment' },
  },
  checkoutNotConfigured: {
    title: { bg: CHECKOUT_NOT_CONFIGURED_MESSAGE, en: 'Checkout is temporarily not configured.' },
    badge: { bg: 'ВРЕМЕННО НЕДОСТЪПНО', en: 'TEMPORARILY UNAVAILABLE' },
    copy: { bg: CHECKOUT_NOT_CONFIGURED_MESSAGE, en: 'Checkout is temporarily not configured.' },
    telegram: { bg: 'Опитай по-късно', en: 'Try again later' },
    paymentStatus: 'NOT CONFIGURED',
    paymentHelp: { bg: CHECKOUT_NOT_CONFIGURED_MESSAGE, en: 'Checkout is temporarily not configured.' },
    buttonLabel: { bg: 'Опитай по-късно', en: 'Try again later' },
  },
  testCheckoutForbidden: {
    title: { bg: 'TEST плащането е ограничено', en: 'TEST checkout is restricted' },
    badge: { bg: 'НЯМА ДОСТЪП', en: 'ACCESS RESTRICTED' },
    copy: { bg: 'TEST плащането е достъпно само за разрешени тестови профили.', en: 'TEST checkout is available only to approved test accounts.' },
    paymentStatus: 'TEST ACCESS RESTRICTED',
    paymentHelp: { bg: 'Не е започнато плащане. Тестовите връзки не са достъпни за обикновени клиенти.', en: 'No payment has started. Test links are not available to regular customers.' },
    buttonLabel: { bg: 'TEST достъпът е ограничен', en: 'TEST access restricted' },
  },
  error: {
    title: { bg: 'Не успяхме да проверим сесията', en: 'Could not verify the session' },
    badge: { bg: 'ГРЕШКА', en: 'ERROR' },
    copy: { bg: 'Временно не може да се свържем с backend-а. Плащане не е започнало и Premium не е активиран.', en: 'Temporarily unable to reach the backend. No payment has started and Premium is not activated.' },
    telegram: { bg: 'Провери отново', en: 'Check again' },
    paymentStatus: 'CHECK LATER',
    paymentHelp: { bg: 'Опитай отново или се върни в EliZdraveBot след малко.', en: 'Try again or return to EliZdraveBot shortly.' },
    buttonLabel: { bg: 'Опитай отново по-късно', en: 'Try again later' },
  },
  missing: {
    title: { bg: 'Няма свързана checkout сесия', en: 'No linked checkout session' },
    badge: { bg: 'НЕ Е СВЪРЗАНО', en: 'NOT LINKED' },
    copy: { bg: 'Планът по-горе е само визуален избор. За реална покупка EliZdraveBot трябва да създаде краткоживееща server-side сесия, свързана с твоя Telegram профил.', en: 'The plan above is a visual choice only. For a real purchase, EliZdraveBot must create a short-lived server-side session linked to your Telegram profile.' },
    telegram: { bg: 'Очаква защитена сесия', en: 'Awaiting secure session' },
    paymentStatus: 'WAITING',
    paymentHelp: { bg: 'Първо е нужна валидна server-side purchase session. След нейната проверка backend-ът разрешава Stripe Checkout.', en: 'A valid server-side purchase session is needed first. After its verification, the backend enables Stripe Checkout.' },
    buttonLabel: { bg: 'Продължи към сигурно плащане', en: 'Continue to secure payment' },
  },
  checkoutCreating: {
    buttonLabel: { bg: 'Подготвяме плащането…', en: 'Preparing payment…' },
    paymentStatus: 'CREATING CHECKOUT',
    paymentHelp: { bg: 'Създаваме Stripe Checkout само от server-side плана и защитената purchase session.', en: 'Creating Stripe Checkout only from the server-side plan and the secure purchase session.' },
  },
  checkoutError: {
    title: { bg: 'Плащането не можа да стартира', en: 'Payment could not start' },
    badge: { bg: 'ОПИТАЙ ПАК', en: 'TRY AGAIN' },
    copy: { bg: 'Не е извършено плащане и Premium не е активиран. Можеш да опиташ отново със същата валидна сесия.', en: 'No payment was made and Premium is not activated. You can try again with the same valid session.' },
    telegram: { bg: 'Свързано защитено', en: 'Securely linked' },
    paymentStatus: 'CHECKOUT ERROR',
    paymentHelp: { bg: 'При повторен проблем отвори EliZdraveBot и поискай нов защитен линк.', en: 'If the problem persists, open EliZdraveBot and request a new secure link.' },
    buttonLabel: { bg: 'Опитай плащането отново', en: 'Try payment again' },
  },
};

let currentSessionState = null;
let currentPlanId = null;
let currentSessionToken = null;

function getLang() { return window.elizdraveI18n ? window.elizdraveI18n.getLang() : 'bg'; }
function tr(field) { return L(field, getLang()); }

const STATE_MAP = {
  checking: 'checking', expired: 'error', invalid: 'error', verified: 'verified',
  error: 'error', missing: 'missing', checkoutError: 'error',
  checkoutNotConfigured: 'error',
  testCheckoutForbidden: 'error',
};

function applySessionState(stateKey) {
  const s = ui[stateKey];
  if (!s) return;
  const cssState = STATE_MAP[stateKey] || stateKey;
  const planName = currentPlanId ? L(planCatalog[currentPlanId]?.name, getLang()) : '';

  setSessionState(cssState, {
    title: tr(s.title),
    badge: tr(s.badge),
    copy: stateKey === 'verified'
      ? `${getLang() === 'en' ? 'Plan confirmed server-side:' : 'Планът е потвърден server-side:'} ${planName}. ${getLang() === 'en' ? 'You can proceed to secure payment.' : 'Можеш да продължиш към сигурно плащане.'}`
      : tr(s.copy),
    telegram: tr(s.telegram),
    paymentStatus: s.paymentStatus,
    paymentHelp: tr(s.paymentHelp),
  });
  if (s.buttonLabel) configurePaymentButton({ enabled: stateKey === 'verified', label: tr(s.buttonLabel) });
}

async function verifySession(session) {
  currentSessionToken = session;
  verifiedSessionToken = '';
  applySessionState('checking');
  showSessionCode(session);

  try {
    const result = await verifyPurchaseSession({
      apiBaseUrl: API_BASE_URL,
      sessionToken: session,
    });
    if (!result.ok) {
      const expired = result.status === 410;
      currentSessionState = expired ? 'expired' : 'invalid';
      applySessionState(currentSessionState);
      return;
    }

    const payload = result.payload;
    const [planId] = resolvePlan(payload.plan_id);
    if (!planId) {
      currentSessionState = 'invalid';
      applySessionState('invalid');
      return;
    }
    verifiedSessionToken = session;
    currentPlanId = planId;
    renderPlan(planId);

    currentSessionState = 'verified';
    applySessionState('verified');
  } catch (error) {
    console.error('Session verification failed:', error);
    currentSessionState = 'error';
    applySessionState('error');
  }
}

function initPurchasePage() {
  const sessionToken = getPurchaseSessionToken();

  const paymentButton = document.querySelector('[data-payment-button]');
  if (paymentButton) {
    paymentButton.addEventListener('click', startCheckout);
  }

  if (sessionToken && sessionToken.length >= 16) {
    verifySession(sessionToken);
  } else {
    currentSessionState = 'missing';
    applySessionState('missing');
  }

  window.addEventListener('langchange', () => {
    if (currentPlanId) renderPlan(currentPlanId);
    if (currentSessionState) applySessionState(currentSessionState);
  });
}

initPurchasePage();
