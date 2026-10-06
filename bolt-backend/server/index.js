'use strict';

const http = require('node:http');
const { createRequestHandler } = require('./app');
const { PurchaseSessionService } = require('./purchaseSessionService');
const { createServerClient, SupabasePurchaseSessionStore } = require('./supabaseStore');
const { SupabaseEntitlementService } = require('./entitlementService');
const { SupabaseCheckoutStatusService } = require('./checkoutStatusService');
const { StripeService, buildPriceCatalog, assertTestMode } = require('./stripeService');
const { SupabasePaymentService } = require('./paymentService');
const { SupabaseEntitlementWriter } = require('./entitlementWriter');
const { StripeWebhookService } = require('./webhookService');

/**
 * Builds the production runtime: Supabase-backed services + Stripe (test mode)
 * wired to the HTTP request handler. Throws if required env vars are missing.
 */
function createProductionRuntime(env = process.env) {
  const client = createServerClient(env);
  const now = () => new Date();

  const store = new SupabasePurchaseSessionStore({ client, now });

  // Stripe is optional for webhook processing. Checkout is delegated to the
  // canonical purchase API by PurchaseSessionService.
  let stripeService = null;
  let paymentService = null;
  let webhookService = null;
  let entitlementWriter = null;

  if (env.STRIPE_SECRET_KEY && env.STRIPE_SECRET_KEY !== 'sk_test_replace_me') {
    assertTestMode(env.STRIPE_SECRET_KEY);

    stripeService = new StripeService({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      priceCatalog: buildPriceCatalog(env),
      now,
      checkoutExpiresMinutes: Number(env.STRIPE_CHECKOUT_EXPIRES_MINUTES || 30),
      locale: env.STRIPE_CHECKOUT_LOCALE || 'bg',
      paymentMethodTypes: (env.STRIPE_PAYMENT_METHOD_TYPES || 'card').split(',').map((s) => s.trim()),
      automaticTax: env.STRIPE_AUTOMATIC_TAX === 'true',
    });

    paymentService = new SupabasePaymentService({ client, now });
    entitlementWriter = new SupabaseEntitlementWriter({ client, now });
    webhookService = new StripeWebhookService({
      client,
      stripeService,
      paymentService,
      entitlementWriter,
      now,
    });
  }

  const service = new PurchaseSessionService({
    store,
    now,
    ttlMinutes: Number(env.PURCHASE_SESSION_TTL_MINUTES || 15),
    appBaseUrl: env.APP_BASE_URL || '',
  });

  const billingService = new SupabaseEntitlementService({ client, now });
  const checkoutStatusService = new SupabaseCheckoutStatusService({ client, now });

  const internalSecret = env.BOT_PURCHASE_API_SECRET;
  if (!internalSecret || internalSecret === 'replace-with-at-least-32-random-characters') {
    throw new Error('BOT_PURCHASE_API_SECRET must be set to a real secret.');
  }
  // This bearer token is the only thing protecting purchase-session creation
  // and entitlement lookups, so a guessable value must not be accepted.
  if (String(internalSecret).trim().length < 32) {
    throw new Error('BOT_PURCHASE_API_SECRET must be at least 32 characters long.');
  }

  const handler = createRequestHandler({
    service,
    billingService,
    checkoutStatusService,
    webhookService,
    internalSecret,
    appBaseUrl: env.APP_BASE_URL || '',
    readinessCheck: async () => {
      try {
        const { error } = await client.from('purchase_sessions').select('id').limit(1);
        return { ok: !error };
      } catch {
        return { ok: false };
      }
    },
  });

  return { handler, client, service, store, billingService, checkoutStatusService, stripeService, webhookService };
}

function startServer(env = process.env) {
  const { handler } = createProductionRuntime(env);
  const port = Number(env.PORT || 8080);
  const host = env.HOST || '127.0.0.1';

  const server = http.createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ api_version: 1, error: 'internal_error', message: 'Вътрешна грешка.' }));
      }
    }
  });

  server.listen(port, host, () => {
    console.log(`EliZdrave backend listening on http://${host}:${port}`);
  });

  return server;
}

module.exports = { createProductionRuntime, startServer };
