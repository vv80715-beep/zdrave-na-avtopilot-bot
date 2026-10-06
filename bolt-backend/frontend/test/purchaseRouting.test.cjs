'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const frontendSourceFiles = [
  'checkout-routing.js',
  'purchase.js',
  'payment-status.js',
  'confirm-plan.html',
  'seven-day.html',
  'monthly.html',
  'yearly.html',
];

async function routing() {
  return import(path.join(root, 'checkout-routing.js'));
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('desktop/mobile plan entry points do not pass a client plan or provider URL', () => {
  for (const page of ['seven-day.html', 'monthly.html', 'yearly.html']) {
    const source = fs.readFileSync(path.join(root, page), 'utf8');
    assert.match(source, /class="button button-primary purchase-link" href="confirm-plan\.html"/);
    assert.doesNotMatch(source, /confirm-plan\.html\?plan=/);
    assert.doesNotMatch(source, /\sdata-plan=/);
  }

  const confirm = fs.readFileSync(path.join(root, 'confirm-plan.html'), 'utf8');
  assert.match(confirm, /data-payment-button/);
  assert.match(confirm, /src="\/purchase\.js"/);
  assert.doesNotMatch(confirm, /checkout_url|success_url|cancel_url/i);
});

test('checkout verification is GET-first and checkout POST has no client inputs', async () => {
  const { verifyPurchaseSession, requestCheckout } = await routing();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response({ plan_id: 'monthly', status: 'pending' });
    return response({ checkout_url: 'https://example.invalid/checkout/session' });
  };

  const verified = await verifyPurchaseSession({
    fetchImpl,
    apiBaseUrl: '/api',
    sessionToken: 'session-token',
  });
  assert.equal(verified.ok, true);

  const checkout = await requestCheckout({
    fetchImpl,
    apiBaseUrl: '/api',
    sessionToken: 'session-token',
  });
  assert.equal(checkout.ok, true);
  assert.equal(checkout.checkout_url, 'https://example.invalid/checkout/session');
  assert.deepEqual(calls.map(({ options }) => options.method), ['GET', 'POST']);
  assert.deepEqual(calls.map(({ options }) => options.redirect), ['error', 'error']);
  assert.equal(Object.hasOwn(calls[1].options, 'body'), false);
  assert.match(calls[1].url, /\/purchase-sessions\/session-token\/checkout$/);
});

test('preserves a valid opaque session on internal plan and confirm links only', async () => {
  const { preservePurchaseSessionLinks } = await routing();
  const token = 'A'.repeat(32);
  const anchors = [
    { name: 'seven-day desktop confirm', href: 'confirm-plan.html?plan=seven_day' },
    { name: 'monthly mobile confirm', href: '/confirm-plan.html?plan=monthly#mobile' },
    { name: 'yearly desktop confirm', href: 'yearly.html?plan=yearly' },
    { name: 'known index entry point', href: '/index.html?plan=monthly' },
    { name: 'external purchase link', href: 'https://external.example/confirm-plan.html?plan=yearly' },
    { name: 'unknown internal page', href: '/payment-status.html?plan=monthly' },
  ].map((entry) => ({
    name: entry.name,
    href: entry.href,
    getAttribute(attribute) {
      return attribute === 'href' ? this.href : null;
    },
    setAttribute(attribute, value) {
      if (attribute === 'href') this.href = value;
    },
  }));
  const documentRef = {
    querySelectorAll(selector) {
      assert.equal(selector, 'a[href]');
      return anchors;
    },
  };

  preservePurchaseSessionLinks(
    documentRef,
    `https://site.test/monthly.html?session=${token}&plan=monthly`,
  );

  assert.equal(anchors[0].href, `/confirm-plan.html?session=${token}`);
  assert.equal(anchors[1].href, `/confirm-plan.html?session=${token}#mobile`);
  assert.equal(anchors[2].href, `/yearly.html?session=${token}`);
  assert.equal(anchors[3].href, `/index.html?session=${token}`);
  assert.equal(anchors[4].href, 'https://external.example/confirm-plan.html?plan=yearly');
  assert.equal(anchors[5].href, '/payment-status.html?plan=monthly');
  assert.equal(anchors[4].href.includes(token), false);
});

test('invalid opaque session does not modify any purchase links', async () => {
  const { preservePurchaseSessionLinks } = await routing();
  const anchors = ['confirm-plan.html?plan=monthly', 'https://external.example/confirm-plan.html?plan=yearly']
    .map((href) => ({
      href,
      getAttribute(attribute) {
        return attribute === 'href' ? this.href : null;
      },
      setAttribute(attribute, value) {
        if (attribute === 'href') this.href = value;
      },
    }));
  const before = anchors.map((anchor) => anchor.href);

  preservePurchaseSessionLinks(
    { querySelectorAll: () => anchors },
    'https://site.test/monthly.html?session=too-short',
  );

  assert.deepEqual(anchors.map((anchor) => anchor.href), before);
});

test('CHECKOUT_NOT_CONFIGURED is explicit and never redirects', async () => {
  const {
    CHECKOUT_NOT_CONFIGURED_MESSAGE,
    redirectToBackendCheckout,
    requestCheckout,
  } = await routing();
  let redirects = 0;
  const result = await requestCheckout({
    fetchImpl: async () => response({
      error: 'CHECKOUT_NOT_CONFIGURED',
      message: 'backend detail must not replace the user-facing guard',
    }, 503),
    apiBaseUrl: '/api',
    sessionToken: 'session-token',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'checkout_not_configured');
  assert.equal(result.message, CHECKOUT_NOT_CONFIGURED_MESSAGE);
  assert.equal(redirectToBackendCheckout(result, () => { redirects += 1; }).ok, false);
  assert.equal(redirects, 0);
});

test('invalid, missing, and non-HTTPS checkout URLs never redirect', async () => {
  const { redirectToBackendCheckout, requestCheckout } = await routing();
  for (const checkout_url of [undefined, '/checkout', 'http://example.invalid/checkout', 'not a url']) {
    const result = await requestCheckout({
      fetchImpl: async () => response({ checkout_url }),
      apiBaseUrl: '/api',
      sessionToken: 'session-token',
    });
    assert.equal(result.ok, false);
    let redirected = false;
    redirectToBackendCheckout(result, () => { redirected = true; });
    assert.equal(redirected, false);
  }
});

test('frontend source has no provider-specific payment URLs or UUID literals', () => {
  const source = frontendSourceFiles
    .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /revolut/i);
  assert.doesNotMatch(source, /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
});

test('frontend uses the pinned purchase-session authority', async () => {
  const { getCheckoutApiBaseUrl } = await routing();
  assert.equal(
    getCheckoutApiBaseUrl(),
    'https://aoaylzncorwakxcactox.supabase.co/functions/v1/api',
  );
});