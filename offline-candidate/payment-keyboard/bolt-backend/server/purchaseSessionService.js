'use strict';

const crypto = require('node:crypto');
const { PLANS, isValidPlanId } = require('./plans');

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;
const CANONICAL_CHECKOUT_ENDPOINT =
  'https://aoaylzncorwakxcactox.supabase.co/functions/v1/api/purchase-sessions';
const CHECKOUT_TIMEOUT_MS = 10_000;

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function normalizeTelegramUserId(value) {
  const s = String(value ?? '').trim();
  return /^\d{5,20}$/.test(s) ? s : null;
}

/**
 * In-memory store used by tests and offline development.
 */
class MemoryPurchaseSessionStore {
  constructor({ now = () => new Date() } = {}) {
    this.sessions = new Map();
    this.now = now;
  }

  async create({ id, tokenHash, telegramUserId, planId, expiresAt }) {
    this.sessions.set(tokenHash, {
      id,
      token_hash: tokenHash,
      telegram_user_id: telegramUserId,
      plan_id: planId,
      status: 'pending',
      expires_at: expiresAt,
      consumed_at: null,
      created_at: this.now(),
      updated_at: this.now(),
      stripe_checkout_session_id: null,
      stripe_checkout_expires_at: null,
      checkout_created_at: null,
    });
  }

  async findByTokenHash(tokenHash) {
    return this.sessions.get(tokenHash) || null;
  }

  async updateStatus(tokenHash, status, extra = {}) {
    const session = this.sessions.get(tokenHash);
    if (!session) return null;
    Object.assign(session, extra, { status, updated_at: this.now() });
    return session;
  }

  /**
   * Atomic single-use claim: succeeds only while no Stripe Checkout Session
   * has been attached yet, so concurrent callers cannot both proceed.
   */
  async claimForCheckout(tokenHash) {
    const session = this.sessions.get(tokenHash);
    if (!session) return null;
    if (session.stripe_checkout_session_id) return null;
    if (session.status !== 'pending' && session.status !== 'checkout_created') return null;
    session.status = 'checkout_created';
    session.updated_at = this.now();
    return session;
  }
}

/**
 * Postgres-backed store. Uses the existing purchase_sessions table.
 */
class PostgresPurchaseSessionStore {
  constructor({ pool, now = () => new Date() } = {}) {
    if (!pool) throw new Error('PostgresPurchaseSessionStore requires a pool.');
    this.pool = pool;
    this.now = now;
  }

  async create({ id, tokenHash, telegramUserId, planId, expiresAt }) {
    await this.pool.query(
      `INSERT INTO purchase_sessions
         (id, token_hash, telegram_user_id, plan_id, status, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $6)`,
      [id, tokenHash, telegramUserId, planId, expiresAt, this.now()],
    );
  }

  async findByTokenHash(tokenHash) {
    const result = await this.pool.query(
      `SELECT * FROM purchase_sessions WHERE token_hash = $1`,
      [tokenHash],
    );
    return result.rows[0] || null;
  }

  async updateStatus(tokenHash, status, extra = {}) {
    const sets = ['status = $2', 'updated_at = $3'];
    const values = [tokenHash, status, this.now()];
    let paramIdx = 4;

    if (extra.stripe_checkout_session_id !== undefined) {
      sets.push(`stripe_checkout_session_id = $${paramIdx++}`);
      values.push(extra.stripe_checkout_session_id);
    }
    if (extra.stripe_checkout_expires_at !== undefined) {
      sets.push(`stripe_checkout_expires_at = $${paramIdx++}`);
      values.push(extra.stripe_checkout_expires_at);
    }
    if (extra.checkout_created_at !== undefined) {
      sets.push(`checkout_created_at = $${paramIdx++}`);
      values.push(extra.checkout_created_at);
    }
    if (extra.consumed_at !== undefined) {
      sets.push(`consumed_at = $${paramIdx++}`);
      values.push(extra.consumed_at);
    }

    const result = await this.pool.query(
      `UPDATE purchase_sessions SET ${sets.join(', ')} WHERE token_hash = $1 RETURNING *`,
      values,
    );
    return result.rows[0] || null;
  }

  /**
   * Atomic single-use claim: succeeds only while no Stripe Checkout Session
   * has been attached yet, so concurrent callers cannot both proceed.
   */
  async claimForCheckout(tokenHash) {
    const result = await this.pool.query(
      `UPDATE purchase_sessions
          SET status = 'checkout_created', updated_at = $2
        WHERE token_hash = $1
          AND status IN ('pending', 'checkout_created')
          AND stripe_checkout_session_id IS NULL
        RETURNING *`,
      [tokenHash, this.now()],
    );
    return result.rows[0] || null;
  }
}

class PurchaseSessionService {
  constructor({
    store,
    now = () => new Date(),
    ttlMinutes = 15,
    appBaseUrl = '',
    // The fetch dependency is injectable for unit tests only. The canonical
    // checkout endpoint above is intentionally not configurable.
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!store) throw new Error('PurchaseSessionService requires a store.');
    this.store = store;
    this.now = now;
    this.ttlMinutes = ttlMinutes;
    this.appBaseUrl = appBaseUrl;
    this.fetchImpl = fetchImpl;
  }

  async createSession({ telegramUserId, planId }) {
    const userId = normalizeTelegramUserId(telegramUserId);
    if (!userId) {
      return this._error('invalid_telegram_user', 'Невалиден Telegram user ID.', 400);
    }
    if (!isValidPlanId(planId)) {
      return this._error('invalid_plan', 'Невалиден canonical plan.', 400);
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    const id = crypto.randomUUID();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.ttlMinutes * 60_000);

    await this.store.create({
      id,
      tokenHash,
      telegramUserId: userId,
      planId,
      expiresAt,
    });

    const plan = PLANS[planId];
    const purchaseUrl = `${this.appBaseUrl}/confirm-plan.html?session=${token}`;

    return {
      ok: true,
      status: 201,
      body: {
        api_version: 1,
        purchase_url: purchaseUrl,
        expires_at: expiresAt.toISOString(),
        plan: { id: plan.id, name: plan.name },
      },
      token,
    };
  }

  async verifySession(token) {
    const normalized = String(token ?? '').trim();
    if (!TOKEN_RE.test(normalized)) {
      return this._error('invalid_session_token', 'Невалиден session token.', 400);
    }

    const tokenHash = hashToken(normalized);
    const session = await this.store.findByTokenHash(tokenHash);
    if (!session) {
      return this._error('session_not_found', 'Сесията не е намерена.', 404);
    }

    const now = this.now();
    if (session.expires_at && new Date(session.expires_at).getTime() <= now.getTime()) {
      if (session.status === 'pending') {
        await this.store.updateStatus(tokenHash, 'expired');
      }
      return this._error('session_expired', 'Сесията е изтекла.', 410);
    }

    if (session.status === 'cancelled' || session.status === 'paid') {
      return this._error('session_consumed', 'Сесията вече е използвана.', 410);
    }

    const plan = PLANS[session.plan_id];
    return {
      ok: true,
      status: 200,
      body: {
        api_version: 1,
        plan_id: plan.id,
        plan: { id: plan.id, name: plan.name },
        status: session.status,
        expires_at: new Date(session.expires_at).toISOString(),
      },
    };
  }

  /**
   * Delegates checkout creation to the website's canonical purchase API.
   * The browser cannot select the plan, return URLs, or another destination:
   * the only outbound request data is this locally validated opaque token.
   */
  async createCheckout(token) {
    const normalized = String(token ?? '').trim();
    if (!TOKEN_RE.test(normalized)) {
      return this._error('invalid_session_token', 'Невалиден session token.', 400);
    }

    const tokenHash = hashToken(normalized);
    const session = await this.store.findByTokenHash(tokenHash);
    if (!session) {
      return this._error('session_not_found', 'Сесията не е намерена.', 404);
    }

    const now = this.now();
    if (session.expires_at && new Date(session.expires_at).getTime() <= now.getTime()) {
      return this._error('session_expired', 'Сесията е изтекла.', 410);
    }

    if (session.status !== 'pending' && session.status !== 'checkout_created') {
      return this._error('session_not_available', 'Сесията не е достъпна за checkout.', 409);
    }

    if (typeof this.fetchImpl !== 'function') {
      return this._error(
        'checkout_not_configured',
        'Каноничната Checkout услуга не е достъпна.',
        503,
      );
    }

    const endpoint = `${CANONICAL_CHECKOUT_ENDPOINT}/${encodeURIComponent(normalized)}/checkout`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECKOUT_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { accept: 'application/json' },
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      });

      let body = {};
      try {
        body = await response.json();
      } catch {
        body = {};
      }

      // Never turn a canonical redirect into a locally selected checkout
      // destination. The adapter only accepts a direct JSON response.
      if (response.status >= 300 && response.status < 400) {
        return this._error(
          'checkout_not_configured',
          'Каноничната Checkout услуга върна неочакван redirect.',
          503,
        );
      }

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          body: {
            api_version: 1,
            error: body.error || 'checkout_error',
            message: body.message || 'Грешка при създаване на Checkout сесия.',
          },
        };
      }

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return this._error(
          'checkout_not_configured',
          'Каноничната Checkout услуга върна невалиден отговор.',
          503,
        );
      }

      return { ok: true, status: response.status, body };
    } catch (error) {
      return this._error(
        'checkout_not_configured',
        'Каноничната Checkout услуга не е достъпна.',
        503,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  _error(code, message, status) {
    return { ok: false, status, body: { api_version: 1, error: code, message } };
  }
}

module.exports = {
  PurchaseSessionService,
  MemoryPurchaseSessionStore,
  PostgresPurchaseSessionStore,
  generateToken,
  hashToken,
  normalizeTelegramUserId,
  TOKEN_RE,
  CANONICAL_CHECKOUT_ENDPOINT,
};
