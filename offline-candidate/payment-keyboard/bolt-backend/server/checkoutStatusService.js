'use strict';

const { PLANS } = require('./plans');

/**
 * Reads real payment and entitlement state from PostgreSQL via Supabase
 * so the frontend can poll /api/checkout-sessions/:id/status.
 *
 * The sessionId is the Stripe Checkout Session ID (stripe_checkout_session_id)
 * stored on the purchase_sessions and payments tables.
 */
class SupabaseCheckoutStatusService {
  constructor({ client, now = () => new Date() } = {}) {
    if (!client) throw new Error('SupabaseCheckoutStatusService requires a client.');
    this.client = client;
    this.now = now;
  }

  /**
   * Looks up a checkout session by its Stripe Checkout Session ID.
   * Returns a safe, frontend-ready status object.
   */
  async getStatus(stripeCheckoutSessionId) {
    const sessionId = String(stripeCheckoutSessionId || '').trim();
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
      return { found: false, state: 'invalid', payment_status: 'invalid' };
    }

    const { data: session, error: sessionError } = await this.client
      .from('purchase_sessions')
      .select('telegram_user_id, plan_id, status, stripe_checkout_session_id')
      .eq('stripe_checkout_session_id', sessionId)
      .maybeSingle();

    if (sessionError) throw sessionError;

    if (!session) {
      return {
        found: false,
        state: 'unknown',
        payment_status: 'unknown',
        entitlement_status: 'waiting',
        plan: null,
        access_expires_at: null,
      };
    }

    const plan = PLANS[session.plan_id] || null;

    const { data: payment, error: paymentError } = await this.client
      .from('payments')
      .select('status, paid_at, stripe_payment_intent_id, stripe_subscription_id')
      .eq('stripe_checkout_session_id', sessionId)
      .maybeSingle();

    if (paymentError) throw paymentError;

    if (!payment || payment.status !== 'paid') {
      return {
        found: true,
        state: 'pending',
        payment_status: payment ? payment.status : 'pending',
        entitlement_status: 'waiting',
        plan: plan ? { id: plan.id, name: plan.name } : null,
        access_expires_at: null,
      };
    }

    const { data: entitlement, error: entError } = await this.client
      .from('entitlements')
      .select('status, expires_at, plan_id')
      .eq('telegram_user_id', session.telegram_user_id)
      .maybeSingle();

    if (entError) throw entError;

    const entActive = entitlement && entitlement.status === 'active'
      && new Date(entitlement.expires_at).getTime() > this.now().getTime();

    return {
      found: true,
      state: entActive ? 'paid' : 'processing',
      payment_status: 'paid',
      entitlement_status: entitlement ? entitlement.status : 'processing',
      plan: plan ? { id: plan.id, name: plan.name } : null,
      access_expires_at: entitlement ? entitlement.expires_at : null,
    };
  }
}

module.exports = { SupabaseCheckoutStatusService };
