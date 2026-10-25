// Secure client for issuing one-time Telegram-to-site profile link codes.
// This is deliberately separate from purchase/entitlement traffic: it has its
// own pinned Supabase function and permits only the code-issuing endpoint.

const APPROVED_LINK_PROJECT_REF = 'aoaylzncorwakxcactox';
const APPROVED_LINK_HOST = `${APPROVED_LINK_PROJECT_REF}.supabase.co`;
const APPROVED_LINK_PATH = '/functions/v1/telegram-link';
const APPROVED_LINK_BASE_URL =
  `https://${APPROVED_LINK_HOST}${APPROVED_LINK_PATH}`;
const ISSUE_PATH = '/issue';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const LINK_CODE_RE = /^[A-Z2-9]{10}$/;
const TELEGRAM_USER_ID_RE = /^\d{5,20}$/;
const MAX_LINK_LIFETIME_MS = 10 * 60 * 1000;
const EXPIRY_CLOCK_TOLERANCE_MS = 30 * 1000;
const INTERNAL_SECRET_PLACEHOLDER =
  'replace-with-at-least-32-random-characters';

class TelegramLinkError extends Error {
  constructor(code, status = null) {
    super(`Telegram link request failed: ${code}`);
    this.name = 'TelegramLinkError';
    this.code = code;
    this.status = status;
  }
}

function validateSecret(value) {
  const secret = String(value || '');
  const normalized = secret.trim();
  if (!normalized) throw new TelegramLinkError('missing_internal_secret');
  if (normalized === INTERNAL_SECRET_PLACEHOLDER) {
    throw new TelegramLinkError('placeholder_internal_secret');
  }
  if (normalized.length < 32) {
    throw new TelegramLinkError('weak_internal_secret');
  }
  return secret;
}

function validateTelegramUserId(value) {
  const id = String(value ?? '').trim();
  if (!TELEGRAM_USER_ID_RE.test(id)) {
    throw new TelegramLinkError('invalid_telegram_user_id');
  }
  return id;
}

function parseBaseUrl(value, allowTestEndpoint) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new TelegramLinkError('invalid_base_url');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new TelegramLinkError('invalid_base_url');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (
    !allowTestEndpoint &&
    (url.hostname !== APPROVED_LINK_HOST ||
      url.pathname !== APPROVED_LINK_PATH)
  ) {
    throw new TelegramLinkError('unapproved_link_endpoint');
  }
  return url.toString().replace(/\/$/, '');
}

async function readResponseTextLimited(response) {
  const declared = Number(response?.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new TelegramLinkError('response_too_large', response?.status || null);
  }

  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new TelegramLinkError(
          'response_too_large',
          response?.status || null
        );
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new TelegramLinkError(
      'response_too_large',
      response?.status || null
    );
  }
  return text;
}

function validateIssueResponse(data, now = Date.now()) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TelegramLinkError('invalid_link_response');
  }
  const keys = Object.keys(data).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== 'code' ||
    keys[1] !== 'expires_at' ||
    !LINK_CODE_RE.test(data.code)
  ) {
    throw new TelegramLinkError('invalid_link_response');
  }
  const expiresAt = Date.parse(data.expires_at);
  if (
    typeof data.expires_at !== 'string' ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + MAX_LINK_LIFETIME_MS + EXPIRY_CLOCK_TOLERANCE_MS
  ) {
    throw new TelegramLinkError('invalid_link_response');
  }
  return { code: data.code, expires_at: data.expires_at };
}

class TelegramLinkClient {
  constructor(options = {}) {
    const nodeEnv = String(process.env.NODE_ENV || '');
    const allowTestEndpoint =
      nodeEnv === 'test' &&
      options.allowUnapprovedEndpointForTests === true;
    this.baseUrl = parseBaseUrl(
      options.baseUrl || APPROVED_LINK_BASE_URL,
      allowTestEndpoint
    );
    this.secret = validateSecret(
      options.secret === undefined
        ? process.env.BOT_PURCHASE_API_SECRET
        : options.secret
    );
    this.fetchImpl = options.fetchImpl || global.fetch;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    if (
      typeof this.fetchImpl !== 'function' ||
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 500 ||
      this.timeoutMs > 30000
    ) {
      throw new TelegramLinkError('invalid_client_configuration');
    }
  }

  async issueCode(telegramUserId) {
    const id = validateTelegramUserId(telegramUserId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${ISSUE_PATH}`, {
          method: 'POST',
          signal: controller.signal,
          redirect: 'error',
          cache: 'no-store',
          headers: {
            Authorization: `Bearer ${this.secret}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ telegram_user_id: id }),
        });
      } catch (error) {
        throw new TelegramLinkError(
          error?.name === 'AbortError' ? 'timeout' : 'network_error'
        );
      }
      if (!response || response.status !== 201) {
        throw new TelegramLinkError('http_error', response?.status || null);
      }
      const text = await readResponseTextLimited(response);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new TelegramLinkError('invalid_json', response.status);
      }
      return validateIssueResponse(data);
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  TelegramLinkClient,
  TelegramLinkError,
  APPROVED_LINK_BASE_URL,
  ISSUE_PATH,
  LINK_CODE_RE,
  MAX_LINK_LIFETIME_MS,
  validateIssueResponse,
};