'use strict';

const crypto = require('node:crypto');
const { PLANS } = require('./plans');

/**
 * Computes the start and expiry timestamps for a plan.
 * Start is now; expiry is start + durationDays.
 * For subscription plans (monthly, yearly), current_period_start/end
 * match starts_at/expires_at for the initial period.
 */
function computePlanPeriod(planId, now) {
  const plan = PLANS[planId];
  if (!plan) throw new Error(`Invalid plan_id: ${planId}`);

  const startsAt = new Date(now.getTime());
  const expiresAt = new Date(startsAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

  return {
    startsAt,
    currentPeriodStart: startsAt,
    currentPeriodEnd: expiresAt,
    expiresAt,
  };
}

/**
 * Upserts an entitlement row for a Telegram user after a verified payment.
 * Server-side date calculation — never trusts client input.
 * Does not grant a second trial: billing_status is always 'paid' or 'active'.
 */
class SupabaseEntitlementWriter {
  constructor({ client, now = () => new Date() } = {}) {
    if (!client) throw new Error('SupabaseEntitlementWriter requires a client.');
    this.client = client;
    this.now = now;
  }

  /**
   * Activates or extends an entitlement after a successful payment.
   * For the initial payment, starts_at is now and expires_at is now + duration.
   * If an active entitlement already exists for the same plan, extends it.
   * If an active entitlement exists for a different plan, replaces it.
   */
  async activateEntitlement({
    telegramUserId,
    planId,
    paymentId,
    stripeCustomerId = null,
    stripeSubscriptionId = null,
  }) {
    const plan = PLANS[planId];
    if (!plan) throw new Error(`Invalid plan_id: ${planId}`);

    const userId = Number(telegramUserId);
    const now = this.now();

    const { data: existing, error: fetchError } = await this.client
      .from('entitlements')
      .select('*')
      .eq('telegram_user_id', userId)
      .maybeSingle();

    if (fetchError) throw fetchError;

    let periodStart, periodEnd, expiresAt, startsAt;

    if (existing && existing.status === 'active' && existing.plan_id === planId) {
      const existingExpiry = new Date(existing.expires_at);
      if (existingExpiry.getTime() > now.getTime()) {
        startsAt = new Date(existing.starts_at);
        periodStart = new Date(existingExpiry);
        periodEnd = new Date(periodStart.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
        expiresAt = periodEnd;
      } else {
        const period = computePlanPeriod(planId, now);
        startsAt = period.startsAt;
        periodStart = period.currentPeriodStart;
        periodEnd = period.currentPeriodEnd;
        expiresAt = period.expiresAt;
      }
    } else {
      const period = computePlanPeriod(planId, now);
      startsAt = period.startsAt;
      periodStart = period.currentPeriodStart;
      periodEnd = period.currentPeriodEnd;
      expiresAt = period.expiresAt;
    }

    const billingStatus = planId === 'seven_day' ? 'paid' : 'active';

    const row = {
      telegram_user_id: userId,
      plan_id: planId,
      status: 'active',
      billing_status: billingStatus,
      stripe_customer_id: stripeCustomerId || null,
      stripe_subscription_id: stripeSubscriptionId || null,
      source_payment_id: paymentId,
      starts_at: startsAt.toISOString(),
      current_period_start: periodStart.toISOString(),
      current_period_end: periodEnd.toISOString(),
      expires_at: expiresAt.toISOString(),
      cancel_at_period_end: false,
      updated_at: now.toISOString(),
    };

    const { data, error } = await this.client
      .from('entitlements')
      .upsert(row, { onConflict: 'telegram_user_id' })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Revokes an entitlement that was granted by a payment which later failed
   * (delayed-notification payment methods can fail after the Checkout Session
   * has already been reported as complete).
   *
   * Scoped to source_payment_id so an unrelated, legitimately paid entitlement
   * for the same Telegram user is never touched.
   */
  async revokeEntitlementForPayment({ telegramUserId, paymentId }) {
    if (!paymentId) return null;
    const userId = Number(telegramUserId);
    if (!Number.isFinite(userId) || userId <= 0) return null;

    const now = this.now();
    const { data, error } = await this.client
      .from('entitlements')
      .update({
        status: 'cancelled',
        billing_status: 'unpaid',
        cancel_at_period_end: true,
        updated_at: now.toISOString(),
      })
      .eq('telegram_user_id', userId)
      .eq('source_payment_id', paymentId)
      .select()
      .maybeSingle();

    if (error) throw error;
    return data;
  }
}

module.exports = { SupabaseEntitlementWriter, computePlanPeriod };
