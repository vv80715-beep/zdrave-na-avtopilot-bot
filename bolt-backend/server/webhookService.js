'use strict';

const crypto = require('node:crypto');

const PROCESSED = 'processed';
const PROCESSING = 'processing';
const FAILED = 'failed';
const IGNORED = 'ignored';

/**
 * Processes Stripe webhook events with idempotency via the stripe_events table.
 * On successful checkout.payment_paid events:
 *   - marks the payment as paid
 *   - activates the entitlement (server-side date calculation)
 *   - preserves the canonical plan key
 */
class StripeWebhookService {
  constructor({
    client,
    stripeService,
    paymentService,
    entitlementWriter,
    now = () => new Date(),
  } = {}) {
    if (!client) throw new Error('StripeWebhookService requires a client.');
    if (!stripeService) throw new Error('StripeWebhookService requires a stripeService.');
    if (!paymentService) throw new Error('StripeWebhookService requires a paymentService.');
    if (!entitlementWriter) throw new Error('StripeWebhookService requires an entitlementWriter.');
    this.client = client;
    this.stripeService = stripeService;
    this.paymentService = paymentService;
    this.entitlementWriter = entitlementWriter;
    this.now = now;
  }

  /**
   * Main entry point. Verifies the webhook signature, deduplicates via
   * stripe_events, and processes the event.
   *
   * Returns { status: 'processed'|'duplicate'|'ignored'|'failed', event }.
   */
  async handleWebhook({ rawBody, signature }) {
    let event;
    try {
      event = this.stripeService.verifyWebhookEvent(rawBody, signature);
    } catch (error) {
      return { status: 'signature_invalid', event: null };
    }

    const eventId = event.id;
    const eventType = event.type;
    const objectId = event.data?.object?.id || null;
    const livemode = Boolean(event.livemode);
    const now = this.now();

    // Idempotency: try to insert as 'processing'. If the event_id already
    // exists, it's a duplicate — return early.
    const { error: insertError } = await this.client.from('stripe_events').insert({
      event_id: eventId,
      event_type: eventType,
      object_id: objectId,
      livemode,
      status: PROCESSING,
      attempts: 1,
      received_at: now.toISOString(),
      updated_at: now.toISOString(),
    });

    if (insertError) {
      // Event already processed or being processed — check its status
      const { data: existing, error: fetchError } = await this.client
        .from('stripe_events')
        .select('status')
        .eq('event_id', eventId)
        .maybeSingle();

      if (fetchError || !existing) {
        return { status: 'failed', event };
      }

      return { status: 'duplicate', event: { id: eventId, type: eventType, status: existing.status } };
    }

    try {
      const result = await this._processEvent(event);

      await this.client.from('stripe_events').update({
        status: PROCESSED,
        processed_at: this.now().toISOString(),
        updated_at: this.now().toISOString(),
      }).eq('event_id', eventId);

      return { status: 'processed', event: { id: eventId, type: eventType, ...result } };
    } catch (error) {
      await this.client.from('stripe_events').update({
        status: FAILED,
        last_error_code: String(error.code || error.message || 'unknown').slice(0, 200),
        updated_at: this.now().toISOString(),
      }).eq('event_id', eventId);

      return { status: 'failed', event: { id: eventId, type: eventType, error: error.message } };
    }
  }

  /**
   * Dispatches to the correct handler based on event type.
   * Only processes payment-success events. Others are marked 'ignored'.
   */
  async _processEvent(event) {
    const type = event.type;
    const obj = event.data?.object;

    if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
      return this._handleCheckoutCompleted(obj, event.id);
    }

    if (type === 'checkout.session.async_payment_failed' || type === 'checkout.session.expired') {
      return this._handleCheckoutFailed(obj, event.id, type);
    }

    // Ignore events we don't process (e.g. customer.updated, invoice.paid)
    return { action: 'ignored', reason: `unhandled_event_type: ${type}` };
  }

  /**
   * Handles a successful checkout: marks payment paid, activates entitlement.
   */
  async _handleCheckoutCompleted(session, eventId) {
    if (!session) return { action: 'ignored', reason: 'no_session_object' };

    // Stripe fires checkout.session.completed as soon as the session finishes,
    // which for delayed-notification payment methods happens while the money
    // has NOT settled (payment_status: 'unpaid'). Never grant access on that.
    const paymentStatus = String(session.payment_status || '');
    if (paymentStatus !== 'paid') {
      return { action: 'ignored', reason: `payment_not_settled: ${paymentStatus || 'unknown'}` };
    }

    const checkoutSessionId = session.id;
    const payment = await this.paymentService.findByCheckoutSessionId(checkoutSessionId);

    if (!payment) {
      return { action: 'ignored', reason: 'no_matching_payment' };
    }

    if (payment.status === 'paid') {
      return { action: 'ignored', reason: 'already_paid' };
    }

    const stripePaymentIntentId = session.payment_intent || null;
    const stripeSubscriptionId = session.subscription || null;
    const stripeCustomerId = session.customer || null;

    const paidPayment = await this.paymentService.markPaid({
      stripeCheckoutSessionId: checkoutSessionId,
      stripePaymentIntentId,
      stripeSubscriptionId,
      stripeCustomerId,
      stripeEventId: eventId,
    });

    await this.entitlementWriter.activateEntitlement({
      telegramUserId: payment.telegram_user_id,
      planId: payment.plan_id,
      paymentId: payment.id,
      stripeCustomerId: stripeCustomerId || null,
      stripeSubscriptionId: stripeSubscriptionId || null,
    });

    return {
      action: 'entitlement_activated',
      paymentId: payment.id,
      telegramUserId: payment.telegram_user_id,
      planId: payment.plan_id,
    };
  }

  /**
   * Handles a failed/expired checkout: marks payment failed.
   */
  async _handleCheckoutFailed(session, eventId, eventType = '') {
    if (!session) return { action: 'ignored', reason: 'no_session_object' };

    const checkoutSessionId = session.id;
    const payment = await this.paymentService.findByCheckoutSessionId(checkoutSessionId);

    if (!payment) {
      return { action: 'ignored', reason: 'no_matching_payment' };
    }

    if (payment.status === 'paid') {
      // A delayed payment that already settled can still fail afterwards.
      // In that case the access granted by THIS payment must be withdrawn.
      if (eventType !== 'checkout.session.async_payment_failed') {
        return { action: 'ignored', reason: 'already_paid' };
      }

      await this.paymentService.markFailed({
        stripeCheckoutSessionId: checkoutSessionId,
        stripeEventId: eventId,
      });

      let revoked = null;
      if (typeof this.entitlementWriter?.revokeEntitlementForPayment === 'function') {
        revoked = await this.entitlementWriter.revokeEntitlementForPayment({
          telegramUserId: payment.telegram_user_id,
          paymentId: payment.id,
        });
      }

      return {
        action: 'payment_failed_entitlement_revoked',
        paymentId: payment.id,
        revoked: Boolean(revoked),
      };
    }

    await this.paymentService.markFailed({
      stripeCheckoutSessionId: checkoutSessionId,
      stripeEventId: eventId,
    });

    return { action: 'payment_failed', paymentId: payment.id };
  }
}

module.exports = { StripeWebhookService };
