'use strict';

const { createClient } = require('@supabase/supabase-js');

/**
 * Creates a Supabase client using the service role key (bypasses RLS).
 * This client is for server-side use only — never expose it to browser code.
 */
function createServerClient(env = process.env) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL is not configured.');
  if (!key || key === 'replace-with-service-role-key') {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured.');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Supabase-backed purchase session store.
 * Uses the existing purchase_sessions table via the PostgREST API.
 */
class SupabasePurchaseSessionStore {
  constructor({ client, now = () => new Date() } = {}) {
    if (!client) throw new Error('SupabasePurchaseSessionStore requires a client.');
    this.client = client;
    this.now = now;
  }

  async create({ id, tokenHash, telegramUserId, planId, expiresAt }) {
    const { error } = await this.client.from('purchase_sessions').insert({
      id,
      token_hash: tokenHash,
      telegram_user_id: Number(telegramUserId),
      plan_id: planId,
      status: 'pending',
      expires_at: expiresAt.toISOString(),
    });
    if (error) throw error;
  }

  async findByTokenHash(tokenHash) {
    const { data, error } = await this.client
      .from('purchase_sessions')
      .select('*')
      .eq('token_hash', tokenHash)
      .maybeSingle();
    if (error) throw error;
    return this._normalizeRow(data);
  }

  async updateStatus(tokenHash, status, extra = {}) {
    const update = {
      status,
      updated_at: this.now().toISOString(),
      ...('stripe_checkout_session_id' in extra && { stripe_checkout_session_id: extra.stripe_checkout_session_id }),
      ...('stripe_checkout_expires_at' in extra && {
        stripe_checkout_expires_at: extra.stripe_checkout_expires_at
          ? new Date(extra.stripe_checkout_expires_at).toISOString()
          : null,
      }),
      ...('checkout_created_at' in extra && {
        checkout_created_at: extra.checkout_created_at
          ? new Date(extra.checkout_created_at).toISOString()
          : null,
      }),
      ...('consumed_at' in extra && {
        consumed_at: extra.consumed_at ? new Date(extra.consumed_at).toISOString() : null,
      }),
    };

    const { data, error } = await this.client
      .from('purchase_sessions')
      .update(update)
      .eq('token_hash', tokenHash)
      .select()
      .maybeSingle();
    if (error) throw error;
    return this._normalizeRow(data);
  }

  /**
   * Atomic single-use claim for checkout creation. The conditional filters run
   * inside one UPDATE statement, so of two concurrent callers exactly one gets
   * a row back and the other gets null.
   */
  async claimForCheckout(tokenHash) {
    const { data, error } = await this.client
      .from('purchase_sessions')
      .update({ status: 'checkout_created', updated_at: this.now().toISOString() })
      .eq('token_hash', tokenHash)
      .in('status', ['pending', 'checkout_created'])
      .is('stripe_checkout_session_id', null)
      .select()
      .maybeSingle();

    if (error) throw error;
    return this._normalizeRow(data);
  }

  _normalizeRow(row) {
    if (!row) return null;
    return {
      ...row,
      expires_at: row.expires_at ? new Date(row.expires_at) : null,
      consumed_at: row.consumed_at ? new Date(row.consumed_at) : null,
      created_at: row.created_at ? new Date(row.created_at) : null,
      updated_at: row.updated_at ? new Date(row.updated_at) : null,
      stripe_checkout_expires_at: row.stripe_checkout_expires_at
        ? new Date(row.stripe_checkout_expires_at) : null,
      checkout_created_at: row.checkout_created_at ? new Date(row.checkout_created_at) : null,
    };
  }
}

module.exports = { createServerClient, SupabasePurchaseSessionStore };
