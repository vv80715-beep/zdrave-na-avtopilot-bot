'use strict';

const PLAN_IDS = Object.freeze(['seven_day', 'monthly', 'yearly']);
const PLAN_ID_SET = new Set(PLAN_IDS);
const MODE_IDS = Object.freeze(['text', 'voice', 'avatar', 'community']);
const MODE_ID_SET = new Set(MODE_IDS);
const TELEGRAM_USER_ID_RE = /^\d{5,20}$/;
const INTERNAL_API_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

class EliPlatformError extends Error {
  constructor(code, message, { httpStatus = 0, retryable = false, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'EliPlatformError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = Boolean(retryable);
  }
}

function normalizeTelegramUserId(value) {
  const normalized = String(value ?? '').trim();
  return TELEGRAM_USER_ID_RE.test(normalized) ? normalized : null;
}

function normalizePlanId(value) {
  const normalized = String(value ?? '').trim();
  return PLAN_ID_SET.has(normalized) ? normalized : null;
}

function normalizeMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return MODE_ID_SET.has(normalized) ? normalized : null;
}

function parseInteger(value, { name, min, max, fallback }) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new EliPlatformError(
      'invalid_configuration',
      `${name} трябва да е цяло число между ${min} и ${max}.`,
    );
  }
  return parsed;
}

function normalizeBaseUrl(value, { production = false } = {}) {
  const raw = String(value ?? '').trim().replace(/\/+$/, '');
  if (!raw) throw new EliPlatformError('missing_base_url', 'ELI_PLATFORM_BASE_URL липсва.');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new EliPlatformError('invalid_base_url', 'ELI_PLATFORM_BASE_URL трябва да е абсолютен URL.', {
      cause,
    });
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new EliPlatformError('invalid_base_url', 'ELI_PLATFORM_BASE_URL трябва да използва HTTP или HTTPS.');
  }
  if (production && parsed.protocol !== 'https:') {
    throw new EliPlatformError('https_required', 'ELI_PLATFORM_BASE_URL трябва да използва HTTPS в production.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new EliPlatformError(
      'invalid_base_url',
      'ELI_PLATFORM_BASE_URL не трябва да съдържа credentials, query или fragment.',
    );
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function validateInternalSecret(value, { production = false } = {}) {
  const secret = String(value ?? '').trim();
  if (!secret) throw new EliPlatformError('missing_internal_secret', 'BOT_PURCHASE_API_SECRET липсва.');
  if (production && secret.length < 32) {
    throw new EliPlatformError(
      'weak_internal_secret',
      'BOT_PURCHASE_API_SECRET трябва да е поне 32 символа в production.',
    );
  }
  return secret;
}

async function readResponseTextLimited(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new EliPlatformError('response_too_large', 'Платформата върна прекалено голям отговор.', {
      httpStatus: response.status,
      retryable: true,
    });
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new EliPlatformError('response_too_large', 'Платформата върна прекалено голям отговор.', {
        httpStatus: response.status,
        retryable: true,
      });
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
      try { await reader.cancel(); } catch {}
      throw new EliPlatformError('response_too_large', 'Платформата върна прекалено голям отговор.', {
        httpStatus: response.status,
        retryable: true,
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text, status) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new EliPlatformError('invalid_json_response', 'Платформата върна невалиден JSON.', {
      httpStatus: status || 502,
      retryable: true,
      cause,
    });
  }
}

function assertApiVersion(payload) {
  if (payload?.api_version !== INTERNAL_API_VERSION) {
    throw new EliPlatformError(
      'api_version_mismatch',
      `Неподдържана API версия. Очаквана версия: ${INTERNAL_API_VERSION}.`,
      { httpStatus: 502 },
    );
  }
}

function normalizeDate(value, fieldName, { required = true } = {}) {
  if ((value == null || value === '') && !required) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new EliPlatformError('invalid_api_response', `Платформата върна невалидно поле ${fieldName}.`, {
      httpStatus: 502,
      retryable: true,
    });
  }
  return date;
}

function normalizePurchaseResponse(payload, { requestedPlanId, baseUrl, purchaseUrlOrigin = null }) {
  assertApiVersion(payload);
  const plan = payload?.plan;
  if (!plan || plan.id !== requestedPlanId) {
    throw new EliPlatformError('plan_mismatch', 'Платформата върна различен план.', {
      httpStatus: 502,
      retryable: true,
    });
  }

  let purchaseUrl;
  try {
    purchaseUrl = new URL(String(payload.purchase_url || ''));
  } catch (cause) {
    throw new EliPlatformError('invalid_purchase_url', 'Платформата върна невалиден purchase URL.', {
      httpStatus: 502,
      retryable: true,
      cause,
    });
  }

  const expectedOrigin = new URL(purchaseUrlOrigin || baseUrl).origin;
  const queryKeys = [...purchaseUrl.searchParams.keys()];
  const token = purchaseUrl.searchParams.get('session') || '';
  if (
    purchaseUrl.origin !== expectedOrigin
    || purchaseUrl.pathname !== '/confirm-plan.html'
    || queryKeys.length !== 1
    || queryKeys[0] !== 'session'
    || !/^[A-Za-z0-9_-]{32,256}$/.test(token)
  ) {
    throw new EliPlatformError('invalid_purchase_url', 'Платформата върна недоверен purchase URL.', {
      httpStatus: 502,
      retryable: true,
    });
  }

  const expiresAt = normalizeDate(payload.expires_at, 'expires_at');
  return Object.freeze({
    purchaseUrl: purchaseUrl.toString(),
    expiresAt,
    plan: Object.freeze({ ...plan, id: requestedPlanId }),
  });
}

function normalizeEntitlementResponse(payload, { requestedTelegramUserId }) {
  assertApiVersion(payload);
  const checkedAt = normalizeDate(payload.checked_at, 'checked_at');
  const value = payload.entitlement;

  if (value == null) {
    return Object.freeze({
      exists: false,
      active: false,
      telegramUserId: requestedTelegramUserId,
      planId: null,
      plan: null,
      status: 'none',
      billingStatus: null,
      modes: Object.freeze([]),
      avatarMinutesPerMonth: 0,
      startsAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      expiresAt: null,
      cancelAtPeriodEnd: false,
      checkedAt,
    });
  }

  if (String(value.telegram_user_id || '') !== requestedTelegramUserId) {
    throw new EliPlatformError('telegram_user_mismatch', 'Платформата върна друг Telegram потребител.', {
      httpStatus: 502,
      retryable: true,
    });
  }

  const planId = normalizePlanId(value.plan_id);
  if (!planId || value.plan?.id !== planId) {
    throw new EliPlatformError('invalid_entitlement_plan', 'Платформата върна невалиден entitlement план.', {
      httpStatus: 502,
      retryable: true,
    });
  }

  if (!Array.isArray(value.modes)) {
    throw new EliPlatformError('invalid_entitlement_modes', 'Платформата върна невалидни entitlement режими.', {
      httpStatus: 502,
      retryable: true,
    });
  }
  const rawModes = value.modes.map((mode) => String(mode).trim().toLowerCase());
  const normalizedModes = rawModes.map(normalizeMode);
  if (normalizedModes.some((mode) => !mode) || new Set(rawModes).size !== rawModes.length) {
    throw new EliPlatformError('invalid_entitlement_modes', 'Платформата върна непознати или дублирани режими.', {
      httpStatus: 502,
      retryable: true,
    });
  }
  const modes = [...new Set(normalizedModes)];

  const active = value.active === true;
  if (active && modes.length === 0) {
    throw new EliPlatformError('invalid_entitlement_modes', 'Активният entitlement няма разрешени режими.', {
      httpStatus: 502,
      retryable: true,
    });
  }
  if (!active && modes.length !== 0) {
    throw new EliPlatformError('invalid_entitlement_modes', 'Неактивният entitlement не трябва да дава платени режими.', {
      httpStatus: 502,
      retryable: true,
    });
  }

  const avatarMinutesPerMonth = Number(value.avatar_minutes_per_month);
  if (!Number.isInteger(avatarMinutesPerMonth) || avatarMinutesPerMonth < 0 || avatarMinutesPerMonth > 10_000) {
    throw new EliPlatformError('invalid_avatar_allowance', 'Платформата върна невалиден Avatar лимит.', {
      httpStatus: 502,
      retryable: true,
    });
  }
  if ((!active || !modes.includes('avatar')) && avatarMinutesPerMonth !== 0) {
    throw new EliPlatformError('invalid_avatar_allowance', 'Avatar лимитът не съответства на разрешените режими.', {
      httpStatus: 502,
      retryable: true,
    });
  }

  const startsAt = normalizeDate(value.starts_at, 'starts_at');
  const currentPeriodStart = normalizeDate(value.current_period_start, 'current_period_start');
  const currentPeriodEnd = normalizeDate(value.current_period_end, 'current_period_end');
  const expiresAt = normalizeDate(value.expires_at, 'expires_at');
  if (
    currentPeriodEnd <= currentPeriodStart
    || expiresAt < currentPeriodEnd
    || expiresAt <= startsAt
    || (active && expiresAt <= checkedAt)
  ) {
    throw new EliPlatformError('invalid_entitlement_period', 'Платформата върна невалиден entitlement период.', {
      httpStatus: 502,
      retryable: true,
    });
  }

  return Object.freeze({
    exists: true,
    active,
    telegramUserId: requestedTelegramUserId,
    planId,
    plan: Object.freeze({ ...value.plan }),
    status: String(value.status || ''),
    billingStatus: value.billing_status == null ? null : String(value.billing_status),
    modes: Object.freeze(modes),
    avatarMinutesPerMonth,
    startsAt,
    currentPeriodStart,
    currentPeriodEnd,
    expiresAt,
    cancelAtPeriodEnd: value.cancel_at_period_end === true,
    checkedAt,
  });
}

class EliPlatformClient {
  constructor({
    baseUrl,
    internalSecret,
    purchaseUrlOrigin = null,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    production = process.env.NODE_ENV === 'production',
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new EliPlatformError('missing_fetch', 'Нужен е Fetch-compatible Node runtime.');
    }
    this.baseUrl = normalizeBaseUrl(baseUrl, { production });
    this.internalSecret = validateInternalSecret(internalSecret, { production });
    this.purchaseUrlOrigin = purchaseUrlOrigin
      ? normalizeBaseUrl(purchaseUrlOrigin, { production })
      : null;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = parseInteger(timeoutMs, {
      name: 'ELI_PLATFORM_TIMEOUT_MS', min: 500, max: 30_000, fallback: DEFAULT_TIMEOUT_MS,
    });
    this.maxResponseBytes = parseInteger(maxResponseBytes, {
      name: 'ELI_PLATFORM_MAX_RESPONSE_BYTES', min: 1_024, max: 1024 * 1024, fallback: DEFAULT_MAX_RESPONSE_BYTES,
    });
  }

  static fromEnv(env = process.env, options = {}) {
    return new EliPlatformClient({
      baseUrl: env.ELI_PLATFORM_BASE_URL || env.ELI_PURCHASE_API_BASE_URL,
      internalSecret: env.BOT_PURCHASE_API_SECRET,
      purchaseUrlOrigin: env.ELI_PURCHASE_URL_ORIGIN || null,
      timeoutMs: env.ELI_PLATFORM_TIMEOUT_MS || env.BOT_BILLING_TIMEOUT_MS,
      maxResponseBytes: env.ELI_PLATFORM_MAX_RESPONSE_BYTES || env.BOT_BILLING_MAX_RESPONSE_BYTES,
      production: String(env.NODE_ENV || '').toLowerCase() === 'production',
      ...options,
    });
  }

  async request(pathname, { method = 'GET', body = null, retry = false } = {}) {
    const url = new URL(pathname, `${this.baseUrl}/`);
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new EliPlatformError('invalid_request_path', 'Заявката не е към доверения platform origin.');
    }

    const maxAttempts = retry ? 2 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers = {
          accept: 'application/json',
          authorization: `Bearer ${this.internalSecret}`,
          'user-agent': 'EliZdraveBot-PlatformBridge/1.0',
        };
        const options = {
          method,
          headers,
          signal: controller.signal,
          redirect: 'error',
          cache: 'no-store',
        };
        if (body != null) {
          headers['content-type'] = 'application/json';
          options.body = JSON.stringify(body);
        }

        const response = await this.fetchImpl(url, options);
        const text = await readResponseTextLimited(response, this.maxResponseBytes);
        const payload = parseJson(text, response.status);
        if (!response.ok) {
          const retryable = response.status >= 500 || response.status === 429;
          const message = typeof payload.message === 'string' && payload.message.trim()
            ? payload.message.trim().slice(0, 300)
            : 'Платформата временно не прие заявката.';
          const error = new EliPlatformError(
            String(payload.error || `http_${response.status}`),
            message,
            { httpStatus: response.status, retryable },
          );
          if (retry && retryable && attempt < maxAttempts) {
            lastError = error;
            continue;
          }
          throw error;
        }
        return payload;
      } catch (error) {
        const normalized = error instanceof EliPlatformError
          ? error
          : new EliPlatformError(
            error?.name === 'AbortError' ? 'platform_timeout' : 'platform_unavailable',
            error?.name === 'AbortError'
              ? 'Платформата не отговори навреме.'
              : 'Платформата временно не е достъпна.',
            {
              httpStatus: error?.name === 'AbortError' ? 504 : 503,
              retryable: true,
              cause: error,
            },
          );
        if (retry && normalized.retryable && attempt < maxAttempts) {
          lastError = normalized;
          continue;
        }
        throw normalized;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || new EliPlatformError('platform_request_failed', 'Платформата не прие заявката.');
  }

  async createPurchaseSession({ telegramUserId, planId }) {
    const userId = normalizeTelegramUserId(telegramUserId);
    const canonicalPlanId = normalizePlanId(planId);
    if (!userId) throw new EliPlatformError('invalid_telegram_user', 'Невалиден Telegram user ID.', { httpStatus: 400 });
    if (!canonicalPlanId) throw new EliPlatformError('invalid_plan', 'Невалиден canonical plan.', { httpStatus: 400 });

    const payload = await this.request('/api/internal/purchase-sessions', {
      method: 'POST',
      body: { telegram_user_id: userId, plan_id: canonicalPlanId },
      retry: false,
    });
    return normalizePurchaseResponse(payload, {
      requestedPlanId: canonicalPlanId,
      baseUrl: this.baseUrl,
      purchaseUrlOrigin: this.purchaseUrlOrigin,
    });
  }

  async getEntitlement(telegramUserId) {
    const userId = normalizeTelegramUserId(telegramUserId);
    if (!userId) throw new EliPlatformError('invalid_telegram_user', 'Невалиден Telegram user ID.', { httpStatus: 400 });

    const payload = await this.request(`/api/internal/entitlements/${encodeURIComponent(userId)}`, {
      method: 'GET',
      retry: true,
    });
    return normalizeEntitlementResponse(payload, { requestedTelegramUserId: userId });
  }

  async checkReady() {
    const payload = await this.request('/api/ready', { method: 'GET', retry: true });
    assertApiVersion(payload);
    if (payload?.ok !== true) {
      throw new EliPlatformError('service_not_ready', 'Платформата не е готова.', {
        httpStatus: 503,
        retryable: true,
      });
    }
    return payload;
  }
}

module.exports = {
  EliPlatformClient,
  EliPlatformError,
  PLAN_IDS,
  MODE_IDS,
  TELEGRAM_USER_ID_RE,
  INTERNAL_API_VERSION,
  normalizeTelegramUserId,
  normalizePlanId,
  normalizeMode,
  normalizeBaseUrl,
  validateInternalSecret,
  normalizePurchaseResponse,
  normalizeEntitlementResponse,
  readResponseTextLimited,
};
