// Small, internal client for the production Bolt purchase/entitlement backend.
// Native fetch only; no Stripe logic and no secret values in logs/errors.

// Paths are relative to the Supabase Edge Function slug in baseUrl
// (/functions/v1/api). Do not prepend another /api segment.
const PURCHASE_PATH = '/internal/purchase-sessions';
const ENTITLEMENT_PATH = '/internal/entitlements';
const CANONICAL_PLAN_IDS = new Set(['seven_day', 'monthly', 'yearly']);
const CANONICAL_MODE_IDS = new Set(['text', 'voice', 'avatar', 'community']);
const PLAN_MODE_IDS = {
  seven_day: new Set(['text', 'voice', 'community']),
  monthly: new Set(['text', 'voice', 'avatar', 'community']),
  yearly: new Set(['text', 'voice', 'avatar', 'community']),
};
const APPROVED_SUPABASE_PROJECT_REF = 'aoaylzncorwakxcactox';
const APPROVED_PLATFORM_HOST =
  `${APPROVED_SUPABASE_PROJECT_REF}.supabase.co`;
const APPROVED_PLATFORM_PATH = '/functions/v1/api';
const APPROVED_PLATFORM_BASE_URL =
  `https://${APPROVED_PLATFORM_HOST}${APPROVED_PLATFORM_PATH}`;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const INTERNAL_SECRET_PLACEHOLDER =
  'replace-with-at-least-32-random-characters';
const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;
const TELEGRAM_USER_ID_RE = /^\d{5,20}$/;

class BoltPlatformError extends Error {
  constructor(code, status = null) {
    super(`Bolt platform request failed: ${code}`);
    this.name = 'BoltPlatformError';
    this.code = code;
    this.status = status;
  }
}

function asTelegramId(value) {
  const id = String(value ?? '').trim();
  if (!TELEGRAM_USER_ID_RE.test(id)) {
    throw new BoltPlatformError('invalid_telegram_user_id');
  }
  return id;
}

function parseBoundedInteger(value, fallback, min, max, code) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) throw new BoltPlatformError(code);
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new BoltPlatformError(code);
  }
  return parsed;
}

function validateInternalSecret(value) {
  const secret = String(value || '');
  const normalized = secret.trim();
  if (!normalized) {
    throw new BoltPlatformError('missing_internal_secret');
  }
  if (normalized === INTERNAL_SECRET_PLACEHOLDER) {
    throw new BoltPlatformError('placeholder_internal_secret');
  }
  if (normalized.length < 32) {
    throw new BoltPlatformError('weak_internal_secret');
  }
  return secret;
}

function isRetryableEntitlementError(error) {
  if (!(error instanceof BoltPlatformError)) return false;
  if (error.code === 'timeout' || error.code === 'network_error') return true;
  return (
    error.code === 'http_error' &&
    (error.status === 429 || (error.status >= 500 && error.status <= 599))
  );
}

function parseBaseUrl(value, { enforceApprovedEndpoint = false } = {}) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch (_) {
    throw new BoltPlatformError('invalid_base_url');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new BoltPlatformError('invalid_base_url');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (
    enforceApprovedEndpoint &&
    (url.hostname !== APPROVED_PLATFORM_HOST ||
      url.port ||
      url.pathname !== APPROVED_PLATFORM_PATH)
  ) {
    throw new BoltPlatformError('unapproved_platform_endpoint');
  }
  return url.toString().replace(/\/$/, '');
}

function parsePurchaseOrigin(value, fallbackBaseUrl) {
  const raw = value || fallbackBaseUrl;
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch (_) {
    throw new BoltPlatformError('invalid_purchase_origin');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new BoltPlatformError('invalid_purchase_origin');
  }
  return url.origin;
}

async function readResponseTextLimited(response, maxBytes) {
  const declared = Number(response?.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BoltPlatformError('response_too_large', response?.status || null);
  }

  if (!response?.body?.getReader) {
    let text;
    if (typeof response?.text === 'function') {
      text = await response.text();
    } else if (typeof response?.json === 'function') {
      text = JSON.stringify(await response.json());
    } else {
      throw new BoltPlatformError('invalid_response', response?.status || null);
    }
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new BoltPlatformError('response_too_large', response?.status || null);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (_) {}
      throw new BoltPlatformError('response_too_large', response.status || null);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonObject(text, status) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new BoltPlatformError('invalid_json', status || null);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new BoltPlatformError('invalid_response', status || null);
  }
  return data;
}

function parseIsoDate(value, errorCode) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BoltPlatformError(errorCode);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new BoltPlatformError(errorCode);
  return timestamp;
}

function validatePurchaseResponse(data, {
  requestedPlanId,
  purchaseOrigin,
}) {
  let purchaseUrl;
  try {
    purchaseUrl = new URL(String(data?.purchase_url || ''));
  } catch (_) {
    throw new BoltPlatformError('invalid_purchase_response');
  }
  const queryKeys = [...purchaseUrl.searchParams.keys()];
  const sessionToken = purchaseUrl.searchParams.get('session') || '';
  const expiresAt = parseIsoDate(
    data?.expires_at,
    'invalid_purchase_response'
  );
  if (
    data?.api_version !== 1 ||
    purchaseUrl.protocol !== 'https:' ||
    purchaseUrl.origin !== purchaseOrigin ||
    purchaseUrl.pathname !== '/confirm-plan.html' ||
    purchaseUrl.username ||
    purchaseUrl.password ||
    purchaseUrl.hash ||
    queryKeys.length !== 1 ||
    queryKeys[0] !== 'session' ||
    !TOKEN_RE.test(sessionToken) ||
    expiresAt <= Date.now() ||
    !data.plan ||
    typeof data.plan !== 'object' ||
    Array.isArray(data.plan) ||
    data.plan.id !== requestedPlanId ||
    typeof data.plan.name !== 'string' ||
    !data.plan.name.trim()
  ) {
    throw new BoltPlatformError('invalid_purchase_response');
  }
  return {
    api_version: 1,
    purchase_url: purchaseUrl.toString(),
    expires_at: data.expires_at,
    plan: { id: data.plan.id, name: data.plan.name.trim() },
  };
}

function validateEntitlementResponse(data, requestedTelegramUserId) {
  const checkedAt = parseIsoDate(
    data?.checked_at,
    'invalid_entitlement_response'
  );
  if (
    data?.api_version !== 1 ||
    !Object.prototype.hasOwnProperty.call(data, 'entitlement')
  ) {
    throw new BoltPlatformError('invalid_entitlement_response');
  }
  const entitlement = data.entitlement;
  if (entitlement === null) return data;
  if (
    !entitlement ||
    typeof entitlement !== 'object' ||
    Array.isArray(entitlement)
  ) {
    throw new BoltPlatformError('invalid_entitlement_response');
  }
  if (
    String(entitlement.telegram_user_id ?? '') !== requestedTelegramUserId
  ) {
    throw new BoltPlatformError('telegram_user_id_mismatch');
  }
  const planId = entitlement.plan_id;
  if (
    !CANONICAL_PLAN_IDS.has(planId) ||
    !entitlement.plan ||
    typeof entitlement.plan !== 'object' ||
    Array.isArray(entitlement.plan) ||
    entitlement.plan.id !== planId ||
    typeof entitlement.plan.name !== 'string' ||
    !entitlement.plan.name.trim() ||
    typeof entitlement.active !== 'boolean' ||
    typeof entitlement.status !== 'string' ||
    !entitlement.status.trim() ||
    typeof entitlement.billing_status !== 'string' ||
    !entitlement.billing_status.trim() ||
    typeof entitlement.cancel_at_period_end !== 'boolean' ||
    !Array.isArray(entitlement.modes)
  ) {
    throw new BoltPlatformError('invalid_entitlement_response');
  }

  const normalizedModes = entitlement.modes.map((mode) =>
    String(mode ?? '').trim().toLowerCase()
  );
  if (
    normalizedModes.some((mode) => !CANONICAL_MODE_IDS.has(mode)) ||
    new Set(normalizedModes).size !== normalizedModes.length ||
    (entitlement.active && !normalizedModes.includes('text')) ||
    (!entitlement.active && normalizedModes.length !== 0)
  ) {
    throw new BoltPlatformError('invalid_entitlement_modes');
  }
  const planModes = normalizedModes.filter((mode) =>
    PLAN_MODE_IDS[planId].has(mode)
  );
  if (entitlement.active && !planModes.includes('text')) {
    throw new BoltPlatformError('invalid_entitlement_modes');
  }

  const avatarMinutes = entitlement.avatar_minutes_per_month;
  if (
    !Number.isInteger(avatarMinutes) ||
    avatarMinutes < 0 ||
    avatarMinutes > 10000 ||
    ((!entitlement.active || !planModes.includes('avatar')) &&
      avatarMinutes !== 0)
  ) {
    throw new BoltPlatformError('invalid_avatar_allowance');
  }

  const startsAt = parseIsoDate(
    entitlement.starts_at,
    'invalid_entitlement_period'
  );
  const currentPeriodStart = parseIsoDate(
    entitlement.current_period_start,
    'invalid_entitlement_period'
  );
  const currentPeriodEnd = parseIsoDate(
    entitlement.current_period_end,
    'invalid_entitlement_period'
  );
  const expiresAt = parseIsoDate(
    entitlement.expires_at,
    'invalid_entitlement_period'
  );
  if (
    currentPeriodEnd <= currentPeriodStart ||
    expiresAt < currentPeriodEnd ||
    expiresAt <= startsAt ||
    (entitlement.active && startsAt > checkedAt) ||
    (entitlement.active && expiresAt <= checkedAt) ||
    (entitlement.active && entitlement.status !== 'active')
  ) {
    throw new BoltPlatformError('invalid_entitlement_period');
  }
  return {
    ...data,
    entitlement: {
      ...entitlement,
      modes: planModes,
    },
  };
}

class EliPlatformClient {
  constructor(options = {}) {
    const nodeEnv = String(process.env.NODE_ENV || '');
    const production = nodeEnv.trim().toLowerCase() === 'production';
    const allowTestEndpoint =
      !production &&
      nodeEnv === 'test' &&
      options.allowUnapprovedEndpointForTests === true;
    const {
      baseUrl = APPROVED_PLATFORM_BASE_URL,
      secret = process.env.BOT_PURCHASE_API_SECRET,
      purchaseUrlOrigin = process.env.ELI_PURCHASE_URL_ORIGIN,
      fetchImpl = global.fetch,
      timeoutMs =
        process.env.ELI_PLATFORM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
      maxResponseBytes =
        process.env.ELI_PLATFORM_MAX_RESPONSE_BYTES ||
        DEFAULT_MAX_RESPONSE_BYTES,
    } = options;

    this.baseUrl = parseBaseUrl(baseUrl, {
      enforceApprovedEndpoint: !allowTestEndpoint,
    });
    this.secret = validateInternalSecret(secret);
    this.purchaseOrigin = parsePurchaseOrigin(
      purchaseUrlOrigin,
      this.baseUrl
    );
    this.fetchImpl = fetchImpl;
    this.timeoutMs = parseBoundedInteger(
      timeoutMs,
      DEFAULT_TIMEOUT_MS,
      500,
      30000,
      'invalid_timeout'
    );
    this.maxResponseBytes = parseBoundedInteger(
      maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      1024,
      1024 * 1024,
      'invalid_max_response_bytes'
    );
  }

  isConfigured() {
    return Boolean(
      this.baseUrl &&
      this.secret &&
      typeof this.fetchImpl === 'function'
    );
  }

  async request(path, {
    method = 'GET',
    body,
    retryTransientEntitlement = false,
  } = {}) {
    if (!this.isConfigured()) throw new BoltPlatformError('not_configured');
    if (
      typeof path !== 'string' ||
      !path.startsWith('/internal/') ||
      path.includes('://')
    ) {
      throw new BoltPlatformError('invalid_request_path');
    }

    const maxAttempts = retryTransientEntitlement ? 2 : 1;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        let response;
        try {
          response = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method,
            signal: controller.signal,
            redirect: 'error',
            cache: 'no-store',
            headers: {
              Authorization: `Bearer ${this.secret}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        } catch (err) {
          const code = err?.name === 'AbortError' ? 'timeout' : 'network_error';
          throw new BoltPlatformError(code);
        }

        if (!response || !response.ok) {
          throw new BoltPlatformError('http_error', response?.status || null);
        }
        const text = await readResponseTextLimited(
          response,
          this.maxResponseBytes
        );
        return parseJsonObject(text, response.status);
      } catch (error) {
        lastError = error;
        if (
          attempt >= maxAttempts ||
          !isRetryableEntitlementError(error)
        ) {
          throw error;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new BoltPlatformError('network_error');
  }

  async createPurchaseSession(telegramUserId, planId) {
    const telegramId = asTelegramId(telegramUserId);
    if (!CANONICAL_PLAN_IDS.has(planId)) {
      throw new BoltPlatformError('invalid_plan');
    }
    const data = await this.request(PURCHASE_PATH, {
      method: 'POST',
      body: {
        telegram_user_id: telegramId,
        plan_id: planId,
      },
    });
    return validatePurchaseResponse(data, {
      requestedPlanId: planId,
      purchaseOrigin: this.purchaseOrigin,
    });
  }

  async getEntitlement(telegramUserId) {
    const telegramId = asTelegramId(telegramUserId);
    const data = await this.request(
      `${ENTITLEMENT_PATH}/${encodeURIComponent(telegramId)}`,
      { retryTransientEntitlement: true }
    );
    return validateEntitlementResponse(data, telegramId);
  }
}

module.exports = {
  EliPlatformClient,
  BoltPlatformError,
  CANONICAL_PLAN_IDS,
  CANONICAL_MODE_IDS,
  PURCHASE_PATH,
  ENTITLEMENT_PATH,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  INTERNAL_SECRET_PLACEHOLDER,
  APPROVED_SUPABASE_PROJECT_REF,
  APPROVED_PLATFORM_HOST,
  APPROVED_PLATFORM_PATH,
  APPROVED_PLATFORM_BASE_URL,
  TOKEN_RE,
  validateInternalSecret,
  isRetryableEntitlementError,
  parseBaseUrl,
  validatePurchaseResponse,
  validateEntitlementResponse,
  readResponseTextLimited,
};