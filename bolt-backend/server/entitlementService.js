'use strict';

const { PLANS } = require('./plans');

/**
 * Reads entitlement state from the entitlements table via Supabase.
 * The backend is the source of truth for plan and access expiry.
 */
class SupabaseEntitlementService {
  constructor({ client, now = () => new Date() } = {}) {
    if (!client) throw new Error('SupabaseEntitlementService requires a client.');
    this.client = client;
    this.now = now;
  }

  /**
   * Returns the internal entitlement shape expected by the bot bridge,
   * or null if no entitlement row exists for the user.
   */
  async getInternalEntitlement(telegramUserId) {
    const userId = String(telegramUserId).trim();
    if (!/^\d{5,20}$/.test(userId)) return null;

    const { data, error } = await this.client
      .from('entitlements')
      .select('*')
      .eq('telegram_user_id', Number(userId))
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    const plan = PLANS[data.plan_id] || { id: data.plan_id, name: data.plan_id };
    const now = this.now();
    const expiresAt = data.expires_at ? new Date(data.expires_at) : null;
    const active = data.status === 'active' && expiresAt && expiresAt.getTime() > now.getTime();

    return {
      telegram_user_id: String(data.telegram_user_id),
      active,
      plan_id: data.plan_id,
      plan: { id: plan.id, name: plan.name },
      status: data.status,
      billing_status: data.billing_status,
      modes: active ? plan.modes : [],
      avatar_minutes_per_month: active ? plan.avatar_minutes_per_month : 0,
      starts_at: data.starts_at,
      current_period_start: data.current_period_start,
      current_period_end: data.current_period_end,
      expires_at: data.expires_at,
      cancel_at_period_end: data.cancel_at_period_end,
      stripe_subscription_id: data.stripe_subscription_id || null,
    };
  }
}

module.exports = { SupabaseEntitlementService };
