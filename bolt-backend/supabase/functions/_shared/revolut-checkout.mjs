/**
 * The only Revolut configuration resolver. Imported server-side only.
 * Values are explicit, verified operator configuration; never URL defaults.
 */
import { TEST_LINK_URLS } from './revolut-test-links.mjs';

export const RETIRED_LINK_DIGESTS = Object.freeze([
  '27b193f4c3fb988cfff5b72a91b0e8dd5e75ab1cfa2646c30bea7fc431dc5bc9',
  '237e1ce34cd2a7f7d533e4652e54870c11a3abed71a38ef173bc356cd4b568f6',
  '2bfcad81735f45c5362a9028d69773b1d4723aa226b0cd71982704a07e464416',
  '6155e00c47d4b94178a9e3b0e9883b766cec3585c51e302c58c1654ab0ebb26b',
  'cfd694a59f09546694616b72d330b1a65ecf4ae20b3e508486a4be1e34575ac4',
  'fbe44546578617794c8555604399bcb8e59ac79d5ac72c9233daf2ee40268591',
  '17102916d8a5f36ddf245d1656b36b0eae02761006a5f1c4cd1132e93c2b31fd',
]);

const PLAN_IDS = Object.freeze(['seven_day', 'monthly', 'yearly']);
const MODES = Object.freeze(['test', 'production']);
export const UNCONFIGURED_MESSAGE = 'Checkout временно не е конфигуриран.';

export async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

function unavailable() {
  return { ok: false, status: 503, body: {
    api_version: 1, error: 'checkout_not_configured', message: UNCONFIGURED_MESSAGE,
  } };
}

function error(status, code, message) {
  return { ok: false, status, body: { api_version: 1, error: code, message } };
}

function configKey(mode, planId) {
  return `REVOLUT_${mode.toUpperCase()}_${planId.toUpperCase()}`;
}

export function isAllowedTestCustomer(getEnv, telegramUserId) {
  const raw = getEnv('REVOLUT_TEST_ALLOWED_TELEGRAM_IDS');
  if (typeof raw !== 'string' || !raw.trim()) return false;
  const ids = raw.split(',').map(id => id.trim());
  const validId = /^[1-9][0-9]{0,19}$/;
  if (!ids.every(id => validId.test(id))) return false;
  if (typeof telegramUserId === 'number' && !Number.isSafeInteger(telegramUserId)) return false;
  const id = String(telegramUserId ?? '');
  return validId.test(id) && ids.includes(id);
}

// No network request to the provider: availability/reusability must be verified
// by the operator before attesting this exact URL in the server configuration.
export async function validateLinkUrl(value) {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.host !== 'checkout.revolut.com' ||
        url.username || url.password || url.search || url.hash ||
        url.href !== value) return false;
    const match = /^\/pay\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(url.pathname);
    return !!match && !RETIRED_LINK_DIGESTS.includes(await sha256(match[1]));
  } catch {
    return false;
  }
}

export async function resolveRevolutCheckout({ getEnv, plan, validateUrl = validateLinkUrl }) {
  const mode = getEnv('REVOLUT_CHECKOUT_MODE');
  if (!MODES.includes(mode) || !PLAN_IDS.includes(plan?.id)) return null;
  try {
    const raw = getEnv(configKey(mode, plan.id));
    if (!raw) return null;
    const config = JSON.parse(raw);
    const amountCents = mode === 'test' ? 100 : plan.price.amount * 100;
    if (!config || config.mode !== mode || config.plan_id !== plan.id ||
        config.currency !== 'EUR' || config.amount_cents !== amountCents ||
        config.accept_multiple_payments !== true || config.payment_limit !== 'unlimited' ||
        config.status !== 'active' || config.expires_at !== null ||
        config.verified !== true || !await validateUrl(config.url)) return null;

    // Binding verification to the URL prevents accidentally reusing an
    // attestation after editing just its URL field.
    if (config.verified_url_sha256 !== await sha256(config.url)) return null;
    // Even a correctly re-hashed configuration cannot swap two EUR 1 plans.
    // Retire every previous TEST destination, not just the seven known ones.
    if (mode === 'test' && config.url !== TEST_LINK_URLS[plan.id]) return null;
    // A link must not be shared between modes or plans (even in inactive mode).
    for (const otherMode of MODES) {
      for (const otherPlan of PLAN_IDS) {
        if (otherMode === mode && otherPlan === plan.id) continue;
        const otherRaw = getEnv(configKey(otherMode, otherPlan));
        if (!otherRaw) continue;
        const other = JSON.parse(otherRaw);
        if (other?.url === config.url) return null;
      }
    }
    return {
      mode, url: config.url, amountCents,
      provider: mode === 'test' ? 'revolut_pro_test' : 'revolut_pro',
      // Keep existing TEST manual-confirmation RPC references compatible.
      reference: mode === 'test'
        ? `${plan.id}_eur_1_reusable_v1`
        : `${plan.id}_eur_${plan.price.amount}_reusable_v1`,
    };
  } catch {
    return null;
  }
}

// Internal authenticated diagnostics only. Never return raw environment values,
// URLs, customer IDs, hashes or arbitrary configuration fields.
export async function inspectTestCheckoutConfiguration({ getEnv, plans }) {
  const rawMode = getEnv('REVOLUT_CHECKOUT_MODE');
  const rawIds = getEnv('REVOLUT_TEST_ALLOWED_TELEGRAM_IDS');
  const firstId = typeof rawIds === 'string' ? rawIds.split(',')[0].trim() : '';
  const allowlistConfigured = isAllowedTestCustomer(getEnv, firstId);
  const result = {
    mode: MODES.includes(rawMode) ? rawMode : 'unconfigured',
    tester_allowlist_configured: allowlistConfigured,
    plans: {},
  };
  for (const planId of PLAN_IDS) {
    const raw = getEnv(configKey('test', planId));
    let config = null;
    try { config = raw ? JSON.parse(raw) : null; } catch { /* report invalid, never echo */ }
    const matchingUrl = config?.url === TEST_LINK_URLS[planId];
    const matchingHash = matchingUrl &&
      config?.verified_url_sha256 === await sha256(TEST_LINK_URLS[planId]);
    const resolved = rawMode === 'test'
      ? await resolveRevolutCheckout({ getEnv, plan: plans[planId] })
      : null;
    result.plans[planId] = {
      configured: typeof raw === 'string' && raw.length > 0,
      approved_url_matches: matchingUrl,
      verification_hash_matches: matchingHash,
      ready: allowlistConfigured && resolved?.mode === 'test',
    };
  }
  return result;
}

/**
 * All checkout entry points use this flow. The only plan is the stored plan.
 * resolveCheckout injection is for isolated unit tests, not runtime env routing.
 */
export async function createRevolutCheckout({
  token, store, plans, getEnv, now = () => new Date(),
  resolveCheckout = resolveRevolutCheckout,
}) {
  const normalized = typeof token === 'string' ? token.trim() : '';
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(normalized)) {
    return error(400, 'invalid_session_token', 'Невалиден session token.');
  }
  const tokenHash = await sha256(normalized);
  const session = await store.find(tokenHash);
  if (!session) return error(404, 'session_not_found', 'Сесията не е намерена.');
  const instant = now();
  const expiresAt = Date.parse(session.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= instant.getTime()) {
    return error(410, 'session_expired', 'Сесията е изтекла.');
  }
  const plan = Object.hasOwn(plans, session.plan_id) ? plans[session.plan_id] : null;
  if (!plan || !PLAN_IDS.includes(plan.id)) return error(400, 'invalid_plan', 'Невалиден план.');
  if (!['pending', 'checkout_created'].includes(session.status) ||
      session.stripe_checkout_session_id) {
    return error(409, 'session_not_available', 'Сесията не е достъпна за checkout.');
  }
  const testAccessDenied = () => error(
    403, 'test_checkout_forbidden', 'TEST плащането е достъпно само за разрешени тестови профили.',
  );
  if (getEnv('REVOLUT_CHECKOUT_MODE') === 'test' &&
      !isAllowedTestCustomer(getEnv, session.telegram_user_id)) {
    return testAccessDenied();
  }
  const checkout = await resolveCheckout({ getEnv, plan });
  // Resolve BEFORE any claim/write, including repeat requests. Never serve a
  // cached old URL after configuration has been disabled or a mode changed.
  if (!checkout) return unavailable();
  if (checkout.mode === 'test' && !isAllowedTestCustomer(getEnv, session.telegram_user_id)) {
    return testAccessDenied();
  }
  if (session.status === 'checkout_created') {
    if (session.checkout_provider !== checkout.provider ||
        session.checkout_reference !== checkout.reference) {
      return error(409, 'session_already_claimed', 'Сесията е за друг checkout режим.');
    }
  } else {
    const claimed = await store.claim(session, {
      status: 'checkout_created',
      checkout_provider: checkout.provider,
      checkout_reference: checkout.reference,
      checkout_created_at: instant.toISOString(),
      expires_at: new Date(instant.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      updated_at: instant.toISOString(),
    }, instant.toISOString());
    if (!claimed) return error(409, 'session_not_available', 'Сесията вече се обработва.');
  }
  return { ok: true, status: 200, body: {
    api_version: 1, plan_id: plan.id, plan: { id: plan.id, name: plan.name },
    checkout_provider: checkout.provider, checkout_reference: checkout.reference,
    checkout_mode: checkout.mode, checkout_url: checkout.url,
    ...(checkout.mode === 'test' ? {
      test_amount: { amount_cents: 100, currency: 'eur' },
      payment_confirmation: 'manual_owner_confirmation_required',
    } : {
      amount: { amount_cents: checkout.amountCents, currency: 'eur' },
      payment_confirmation: 'provider_confirmation_required',
    }),
  } };
}