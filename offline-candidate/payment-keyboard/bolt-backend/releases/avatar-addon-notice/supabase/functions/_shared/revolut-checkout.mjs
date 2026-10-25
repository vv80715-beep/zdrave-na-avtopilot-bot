/** Single checkout resolver. No legacy URL, environment-URL or Stripe fallback. */
import { TEST_LINK_URLS, TESTER_TELEGRAM_IDS, TEST_CATALOG_VERSION } from './revolut-test-links.mjs';

const PLAN_IDS = Object.freeze(['seven_day', 'monthly', 'yearly']);
export const UNCONFIGURED_MESSAGE = 'Checkout configuration is unavailable.';
const error = (status, code, message) => ({ ok: false, status, body: { api_version: 1, error: code, message } });

export async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export function isAllowedTestCustomer(_getEnv, telegramUserId) {
  if (typeof telegramUserId === 'number' && !Number.isSafeInteger(telegramUserId)) return false;
  const id = String(telegramUserId ?? '');
  return /^[1-9][0-9]{4,15}$/.test(id) && TESTER_TELEGRAM_IDS.includes(id);
}

export async function validateLinkUrl(value) {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.host === 'checkout.revolut.com'
      && !url.username && !url.password && !url.search && !url.hash
      && url.href === value
      && /^\/pay\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(url.pathname)
      && Object.values(TEST_LINK_URLS).includes(value);
  } catch { return false; }
}

export async function resolveRevolutCheckout({ plan }) {
  if (!PLAN_IDS.includes(plan?.id)) return null;
  const urls = PLAN_IDS.map(id => TEST_LINK_URLS[id]);
  if (new Set(urls).size !== PLAN_IDS.length || !(await Promise.all(urls.map(validateLinkUrl))).every(Boolean)) return null;
  return {
    mode: 'test', url: TEST_LINK_URLS[plan.id], amountCents: 100,
    provider: 'revolut_pro_test', reference: `${plan.id}_eur_1_reusable_v1`,
  };
}

// Same authenticated diagnostic route; never exposes secrets or tester IDs.
export async function inspectTestCheckoutConfiguration({ plans }) {
  const result = {
    mode: 'test', configuration_source: 'server_test_catalog', catalog_version: TEST_CATALOG_VERSION,
    tester_allowlist_configured: TESTER_TELEGRAM_IDS.length > 0,
    provider_availability_checked: false, plans: {},
  };
  for (const id of PLAN_IDS) {
    const checkout = await resolveRevolutCheckout({ plan: plans[id] });
    result.plans[id] = { configured: Boolean(checkout), approved_url_matches: Boolean(checkout), ready: Boolean(checkout) };
  }
  return result;
}

export async function createRevolutCheckout({ token, store, plans, now = () => new Date() }) {
  const normalized = typeof token === 'string' ? token.trim() : '';
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(normalized)) return error(400, 'invalid_session_token', 'Invalid session token.');
  const session = await store.find(await sha256(normalized));
  if (!session) return error(404, 'session_not_found', 'Session not found.');
  const instant = now();
  const expiresAt = Date.parse(session.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= instant.getTime()) return error(410, 'session_expired', 'Session expired.');
  const plan = Object.hasOwn(plans, session.plan_id) ? plans[session.plan_id] : null;
  if (!plan || !PLAN_IDS.includes(plan.id)) return error(400, 'invalid_plan', 'Invalid plan.');
  if (!['pending', 'checkout_created'].includes(session.status) || session.stripe_checkout_session_id) {
    return error(409, 'session_not_available', 'Session unavailable for checkout.');
  }
  if (!isAllowedTestCustomer(null, session.telegram_user_id)) return error(403, 'test_checkout_forbidden', 'This real EUR 1 test is restricted to the approved tester.');
  const checkout = await resolveRevolutCheckout({ plan });
  if (!checkout) return error(503, 'checkout_not_configured', UNCONFIGURED_MESSAGE);
  if (session.status === 'checkout_created') {
    if (session.checkout_provider !== checkout.provider || session.checkout_reference !== checkout.reference) {
      return error(409, 'session_already_claimed', 'Session belongs to another checkout flow.');
    }
  } else {
    const claimed = await store.claim(session, {
      status: 'checkout_created', checkout_provider: checkout.provider,
      checkout_reference: checkout.reference, checkout_created_at: instant.toISOString(),
      expires_at: new Date(instant.getTime() + 2 * 60 * 60 * 1000).toISOString(), updated_at: instant.toISOString(),
    }, instant.toISOString());
    if (!claimed) return error(409, 'session_not_available', 'Session is already being processed.');
  }
  // Only a checkout attempt is recorded. No payment or entitlement is granted.
  return { ok: true, status: 200, body: {
    api_version: 1, plan_id: plan.id, plan: { id: plan.id, name: plan.name },
    checkout_provider: checkout.provider, checkout_reference: checkout.reference,
    checkout_mode: 'test', checkout_url: checkout.url, checkout_catalog_version: TEST_CATALOG_VERSION,
    test_amount: { amount_cents: 100, currency: 'eur' },
    payment_confirmation: 'manual_owner_confirmation_required',
  } };
}
