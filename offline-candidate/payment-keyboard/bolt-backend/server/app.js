'use strict';

const crypto = require('node:crypto');
const { PLANS, API_VERSION } = require('./plans');
const { normalizeTelegramUserId } = require('./purchaseSessionService');

/**
 * Timing-safe string comparison to prevent secret timing attacks.
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify({ api_version: API_VERSION, ...body });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: code, message });
}

function parseUrl(url) {
  const [pathname, search] = url.split('?');
  const segments = pathname.split('/').filter(Boolean);
  return { pathname, segments, search };
}

async function readBody(req, maxBytes = 8192) {
  const raw = await readRawBody(req, maxBytes);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid_json');
  }
}

async function readRawBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

const HOST_HEADER_RE = /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/;

/**
 * Derives an origin from the request Host header, but only when the header is a
 * plain hostname[:port]. Anything else (paths, credentials, control characters,
 * multiple hosts) is rejected rather than reflected back into an issued URL.
 */
function safeRequestOrigin(req) {
  const host = String(req.headers?.host || '').trim();
  if (!HOST_HEADER_RE.test(host)) return null;
  return `http://${host}`;
}

function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

/**
 * Creates an HTTP request handler (req, res) with all V11 API routes.
 *
 * Routes:
 *   Public (browser-facing):
 *     GET  /api/ready
 *     GET  /api/purchase-sessions/:token
 *     POST /api/purchase-sessions/:token/checkout
 *     GET  /api/checkout-sessions/:sessionId/status
 *
 *   Internal (bot bridge, Bearer auth):
 *     POST /api/internal/purchase-sessions
 *     GET  /api/internal/entitlements/:telegramUserId
 *
 *   Webhook (Stripe, signature-verified):
 *     POST /api/webhooks/stripe
 */
function createRequestHandler({
  service,
  billingService = null,
  checkoutStatusService = null,
  webhookService = null,
  internalSecret,
  appBaseUrl = '',
  readinessCheck = async () => ({ ok: true }),
} = {}) {
  if (!service) throw new Error('createRequestHandler requires a service.');
  if (!internalSecret) throw new Error('createRequestHandler requires an internalSecret.');

  return async function handler(req, res) {
    try {
      const { segments } = parseUrl(req.url || '/');
      const method = (req.method || 'GET').toUpperCase();

      if (segments[0] !== 'api' || segments.length < 2) {
        return sendError(res, 404, 'not_found', 'Неизвестен маршрут.');
      }

      if (segments[1] === 'ready' && method === 'GET' && segments.length === 2) {
        const result = await readinessCheck();
        return sendJson(res, 200, { ok: Boolean(result.ok) });
      }

      if (segments[1] === 'webhooks' && segments.length === 3 && segments[2] === 'stripe' && method === 'POST') {
        if (!webhookService) {
          return sendError(res, 503, 'webhook_not_configured', 'Webhook обработката не е конфигурирана.');
        }
        let rawBody;
        try {
          rawBody = await readRawBody(req);
        } catch {
          return sendError(res, 400, 'invalid_body', 'Невалидно тяло на заявката.');
        }
        const signature = req.headers['stripe-signature'] || '';
        try {
          const result = await webhookService.handleWebhook({ rawBody: rawBody.toString('utf8'), signature });
          if (result.status === 'signature_invalid') {
            return sendError(res, 400, 'signature_invalid', 'Невалидна Stripe подписка.');
          }
          if (result.status === 'failed') {
            return sendJson(res, 500, { received: true, status: 'failed' });
          }
          if (result.status === 'duplicate') {
            return sendJson(res, 200, { received: true, status: 'duplicate' });
          }
          return sendJson(res, 200, { received: true, status: result.status });
        } catch {
          return sendError(res, 500, 'webhook_error', 'Грешка при обработка на webhook.');
        }
      }

      if (segments[1] === 'purchase-sessions') {
        if (segments.length === 2 && method === 'GET') {
          return sendError(res, 405, 'method_not_allowed', 'Използвай POST за създаване.');
        }

        if (segments.length === 2 && method === 'POST') {
          const token = getBearerToken(req);
          if (!token || !safeEqual(token, internalSecret)) {
            return sendError(res, 401, 'unauthorized', 'Невалидна авторизация.');
          }
          let body;
          try {
            body = await readBody(req);
          } catch {
            return sendError(res, 400, 'invalid_body', 'Невалидно тяло на заявката.');
          }
          const result = await service.createSession({
            telegramUserId: body.telegram_user_id,
            planId: body.plan_id,
          });
          return sendJson(res, result.status, result.body);
        }

        if (segments.length >= 3) {
          const sessionToken = segments[2];

          if (segments.length === 3 && method === 'GET') {
            const result = await service.verifySession(sessionToken);
            return sendJson(res, result.status, result.body);
          }

          if (segments.length === 4 && segments[3] === 'checkout' && method === 'POST') {
            // Checkout is created by the pinned canonical purchase API. No
            // browser-supplied plan, URL, or success/cancel data is forwarded.
            const result = await service.createCheckout(sessionToken);
            return sendJson(res, result.status, result.body);
          }
        }

        return sendError(res, 404, 'not_found', 'Неизвестен маршрут.');
      }

      if (segments[1] === 'checkout-sessions' && segments.length === 4 && segments[3] === 'status' && method === 'GET') {
        const sessionId = segments[2];
        if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
          return sendError(res, 400, 'invalid_session', 'Невалиден Stripe Checkout Session ID.');
        }
        if (checkoutStatusService && typeof checkoutStatusService.getStatus === 'function') {
          try {
            const status = await checkoutStatusService.getStatus(sessionId);
            return sendJson(res, 200, status);
          } catch {
            return sendError(res, 503, 'database_unavailable', 'Базата данни не е достъпна.');
          }
        }
        return sendJson(res, 200, {
          found: false,
          state: 'pending',
          payment_status: 'pending',
          entitlement_status: 'waiting',
          plan: null,
          access_expires_at: null,
          message: 'Stripe Checkout не е конфигуриран. Плащането не е обработено.',
        });
      }

      if (segments[1] === 'internal' && segments.length >= 3) {
        const token = getBearerToken(req);
        if (!token || !safeEqual(token, internalSecret)) {
          return sendError(res, 401, 'unauthorized', 'Невалидна авторизация.');
        }

        if (segments[2] === 'purchase-sessions' && segments.length === 3 && method === 'POST') {
          let body;
          try {
            body = await readBody(req);
          } catch {
            return sendError(res, 400, 'invalid_body', 'Невалидно тяло на заявката.');
          }
          const result = await service.createSession({
            telegramUserId: body.telegram_user_id,
            planId: body.plan_id,
          });
          if (result.ok && result.body.purchase_url) {
            // Prefer the configured base URL. The request Host header is only a
            // last resort and is accepted only as a strict hostname[:port].
            const effectiveBase = appBaseUrl || safeRequestOrigin(req);
            if (effectiveBase) {
              result.body.purchase_url = result.body.purchase_url.replace(
                service.appBaseUrl,
                effectiveBase,
              );
            }
          }
          return sendJson(res, result.status, result.body);
        }

        if (segments[2] === 'entitlements' && segments.length === 4 && method === 'GET') {
          const telegramUserId = segments[3];
          const userId = normalizeTelegramUserId(telegramUserId);
          if (!userId) {
            return sendError(res, 400, 'invalid_telegram_user', 'Невалиден Telegram user ID.');
          }

          if (!billingService || typeof billingService.getInternalEntitlement !== 'function') {
            return sendJson(res, 200, {
              checked_at: new Date().toISOString(),
              entitlement: null,
            });
          }

          const entitlement = await billingService.getInternalEntitlement(userId);
          if (!entitlement) {
            return sendJson(res, 200, {
              checked_at: new Date().toISOString(),
              entitlement: null,
            });
          }

          const plan = PLANS[entitlement.plan_id] || {
            id: entitlement.plan_id,
            name: entitlement.plan?.name || entitlement.plan_id,
          };

          return sendJson(res, 200, {
            checked_at: new Date().toISOString(),
            entitlement: {
              telegram_user_id: String(entitlement.telegram_user_id),
              active: Boolean(entitlement.active),
              plan_id: entitlement.plan_id,
              plan: { id: plan.id, name: plan.name },
              status: entitlement.status || (entitlement.active ? 'active' : 'inactive'),
              billing_status: entitlement.billing_status || null,
              modes: entitlement.modes || [],
              avatar_minutes_per_month: entitlement.avatar_minutes_per_month || 0,
              starts_at: entitlement.starts_at,
              current_period_start: entitlement.current_period_start,
              current_period_end: entitlement.current_period_end,
              expires_at: entitlement.expires_at,
              cancel_at_period_end: Boolean(entitlement.cancel_at_period_end),
            },
          });
        }
      }

      return sendError(res, 404, 'not_found', 'Неизвестен маршрут.');
    } catch (error) {
      return sendError(res, 500, 'internal_error', 'Вътрешна грешка.');
    }
  };
}

module.exports = { createRequestHandler };
