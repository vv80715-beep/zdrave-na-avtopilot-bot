import { pathToFileURL } from 'node:url';
import { TEST_LINK_URLS } from '../supabase/functions/_shared/revolut-test-links.mjs';
import { sha256 } from '../supabase/functions/_shared/revolut-checkout.mjs';

// Output only the explicitly supplied nonsecret TEST settings; never read
// credentials, modify Supabase, or write/replace production configuration.
export async function buildTestSettings({ providerVerified = false, testerIds = '' } = {}) {
  if (!/^[1-9][0-9]{0,19}(,[1-9][0-9]{0,19})*$/.test(testerIds)) {
    throw new Error('An explicit comma-separated allowlist of test Telegram IDs is required.');
  }
  const values = {
    REVOLUT_CHECKOUT_MODE: 'test',
    REVOLUT_TEST_ALLOWED_TELEGRAM_IDS: testerIds,
  };
  for (const [planId, url] of Object.entries(TEST_LINK_URLS)) {
    values[`REVOLUT_TEST_${planId.toUpperCase()}`] = JSON.stringify({
      mode: 'test',
      plan_id: planId,
      url,
      currency: 'EUR',
      amount_cents: 100,
      accept_multiple_payments: providerVerified === true,
      payment_limit: providerVerified === true ? 'unlimited' : null,
      status: providerVerified === true ? 'active' : 'unverified',
      expires_at: null,
      verified: providerVerified === true,
      verified_url_sha256: await sha256(url),
    });
  }
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const testerArgument = args.find(arg => arg.startsWith('--testers='));
  const known = args.every(arg => arg === '--provider-verified' || arg.startsWith('--testers='));
  if (!known || !testerArgument) {
    console.error('Usage: node scripts/print-revolut-test-settings.mjs --testers=<IDs> [--provider-verified]');
    process.exitCode = 1;
  } else {
    console.error('PRINT ONLY: no Supabase settings changed. --provider-verified is an operator attestation.');
    try {
      console.log(JSON.stringify(await buildTestSettings({
        testerIds: testerArgument.slice('--testers='.length),
        providerVerified: args.includes('--provider-verified'),
      }), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}