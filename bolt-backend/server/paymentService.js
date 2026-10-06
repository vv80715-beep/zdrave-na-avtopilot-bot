'use strict';

const { PLANS } = require('./plans');

/**
 * Reads and writes the payments table via Supabase.
 * The payment ledger is the canonical record of money flow.
 */
class SupabasePaymentService {
  constructor({ client, now = () => new Date() } = {}) {
    if (!client) throw new Error('SupabasePaymentService requires a client.');
    this.client = client;
    this.now = now;
  }

  /**
   * Creates a pending payment record linked to a Stripe Checkout Session.
   * Returns the created row.
   */
  async createPendingPayment({
    paymentId,
    telegramUserId,
    planId,
    stripeCheckoutSessionId,
    stripeEventId,
  }) {
    const plan = PLANS[planId];
    if (!plan) throw new Error(`Invalid plan_id: ${planId}`);

    const now = this.now();
    const { data, error } = await this.client.from('payments').insert({
      id: paymentId,
      telegram_user_id: Number(telegramUserId),
      plan_id: planId,
      kind: 'initial',
      status: 'pending',
      amount_cents: plan.price.amount * 100,
      currency: plan.price.currency.toLowerCase(),
      stripe_checkout_session_id: stripeCheckoutSessionId,
      first_stripe_event_id: stripeEventId,
      last_stripe_event_id: stripeEventId,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }).select().single();

    if (error) throw error;
    return data;
  }

  /**
   * Marks a payment as paid and records the Stripe payment intent / subscription IDs.
   */
  async markPaid({ stripeCheckoutSessionId, stripePaymentIntentId, stripeSubscriptionId, stripeCustomerId, stripeEventId }) {
    const now = this.now();
    const update = {
      status: 'paid',
      paid_at: now.toISOString(),
      updated_at: now.toISOString(),
      last_stripe_event_id: stripeEventId,
    };
    if (stripePaymentIntentId) update.stripe_payment_intent_id = stripePaymentIntentId;
    if (stripeSubscriptionId) update.stripe_subscription_id = stripeSubscriptionId;
    if (stripeCustomerId) update.stripe_customer_id = stripeCustomerId;

    const { data, error } = await this.client
      .from('payments')
      .update(update)
      .eq('stripe_checkout_session_id', stripeCheckoutSessionId)
      .select()
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  /**
   * Marks a payment as failed.
   */
  async markFailed({ stripeCheckoutSessionId, stripeEventId }) {
    const now = this.now();
    const { data, error } = await this.client
      .from('payments')
      .update({
        status: 'failed',
        failed_at: now.toISOString(),
        updated_at: now.toISOString(),
        last_stripe_event_id: stripeEventId,
      })
      .eq('stripe_checkout_session_id', stripeCheckoutSessionId)
      .select()
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  /**
   * Finds a payment by its Stripe Checkout Session ID.
   */
  async findByCheckoutSessionId(stripeCheckoutSessionId) {
    const { data, error } = await this.client
      .from('payments')
      .select('*')
      .eq('stripe_checkout_session_id', stripeCheckoutSessionId)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  /**
   * Finds a payment by its id (uuid).
   */
  async findById(paymentId) {
    const { data, error } = await this.client
      .from('payments')
      .select('*')
      .eq('id', paymentId)
      .maybeSingle();

    if (error) throw error;
    return data;
  }
}

module.exports = { SupabasePaymentService };
