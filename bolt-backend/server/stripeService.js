'use strict';

const crypto = require('node:crypto');
const { PLANS, isValidPlanId } = require('./plans');

const TEST_KEY_PREFIXES = ['sk_test_', 'rk_test_'];
const LIVE_KEY_PREFIX = 'sk_live_';

/**
 * Returns true only for a Stripe TEST mode key (secret or restricted).
 * Throws for a live key and for any other shape, so an unrecognised
 * credential can never silently start this integration in live mode.
 */
function assertTestMode(secretKey) {
  if (!secretKey) return false;
  if (secretKey.startsWith(LIVE_KEY_PREFIX)) {
    throw new Error('STRIPE_SECRET_KEY is a LIVE key. This integration must use TEST mode only.');
  }
  if (!TEST_KEY_PREFIXES.some((prefix) => secretKey.startsWith(prefix))) {
    throw new Error('STRIPE_SECRET_KEY must be a Stripe TEST mode key (sk_test_ or rk_test_).');
  }
  return true;
}

/**
 * Stripe price catalog: maps canonical plan IDs to Stripe Price IDs
 * from environment variables. These are the only Price IDs the backend
 * will ever use — the browser never sends a price.
 */
function buildPriceCatalog(env = process.env) {
  return {
    seven_day: env.STRIPE_PRICE_SEVEN_DAY || null,
    monthly: env.STRIPE_PRICE_MONTHLY || null,
    yearly: env.STRIPE_PRICE_YEARLY || null,
  };
}

/**
 * Wraps the Stripe SDK for Checkout Session creation.
 * The stripe module is loaded lazily so that tests that don't touch
 * Stripe never require it.
 */
class StripeService {
  constructor({
    stripeLib = null,
    secretKey,
    webhookSecret,
    priceCatalog,
    now = () => new Date(),
    checkoutExpiresMinutes = 30,
    locale = 'bg',
    paymentMethodTypes = ['card'],
    automaticTax = false,
  } = {}) {
    if (!secretKey) throw new Error('StripeService requires a secretKey.');
    assertTestMode(secretKey);
    this.webhookSecret = webhookSecret || null;
    this.priceCatalog = priceCatalog || {};
    this.now = now;
    this.checkoutExpiresMinutes = checkoutExpiresMinutes;
    this.locale = locale;
    this.paymentMethodTypes = paymentMethodTypes;
    this.automaticTax = automaticTax;

    if (stripeLib) {
      this.stripe = stripeLib(secretKey, { apiVersion: '2024-06-20' });
    } else {
      const Stripe = require('stripe');
      this.stripe = new Stripe(secretKey, { apiVersion: '2024-06-20' });
    }
  }

  /**
   * Creates a Stripe Checkout Session for the given canonical plan.
   * Returns { checkoutSessionId, checkoutUrl, expiresAt }.
   * Throws on any Stripe API error.
   */
  async createCheckoutSession({ planId, successUrl, cancelUrl, metadata = {} }) {
    if (!isValidPlanId(planId)) {
      throw new Error(`Invalid plan ID: ${planId}`);
    }

    const priceId = this.priceCatalog[planId];
    if (!priceId) {
      throw new Error(`No Stripe Price ID configured for plan: ${planId}`);
    }

    const plan = PLANS[planId];
    const mode = planId === 'seven_day' ? 'payment' : 'subscription';
    const expiresAt = new Date(this.now().getTime() + this.checkoutExpiresMinutes * 60_000);

    const params = {
      mode,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      expires_at: Math.floor(expiresAt.getTime() / 1000),
      locale: this.locale,
      payment_method_types: this.paymentMethodTypes,
      automatic_tax: this.automaticTax,
      metadata: {
        plan_id: planId,
        plan_name: plan.name,
        source: 'elizdrave_backend',
        ...metadata,
      },
    };

    // The buyer's email is deliberately NOT accepted from the request: the
    // backend holds no trusted email for a Telegram user, so Stripe Checkout
    // collects it itself. See the audit note on customer_email injection.

    const session = await this.stripe.checkout.sessions.create(params);

    return {
      checkoutSessionId: session.id,
      checkoutUrl: session.url,
      expiresAt: new Date(session.expires_at * 1000),
    };
  }

  /**
   * Verifies a Stripe webhook signature using the raw body and
   * the STRIPE_WEBHOOK_SECRET. Returns the parsed event or throws.
   */
  verifyWebhookEvent(rawBody, signature) {
    if (!this.webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured.');
    }
    if (!rawBody || !signature) {
      throw new Error('Missing body or signature.');
    }

    const event = this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      this.webhookSecret,
    );
    return event;
  }
}

module.exports = { StripeService, assertTestMode, buildPriceCatalog };
