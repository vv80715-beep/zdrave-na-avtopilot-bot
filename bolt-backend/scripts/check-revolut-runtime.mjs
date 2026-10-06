// Read-only request to the pinned authority using the existing bot credential.
// No checkout, session creation, configuration mutation or payment is performed.
const endpoint = 'https://aoaylzncorwakxcactox.supabase.co/functions/v1/api/internal/checkout-config-status';
const credential = process.env.BOT_PURCHASE_API_SECRET;
if (!credential) {
  console.error('The existing internal bot credential is not available.');
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.error(`Read-only runtime check failed (HTTP ${response.status}); no response body logged.`);
      process.exitCode = 1;
    } else {
      const payload = await response.json();
      const summary = {
        mode: ['test', 'production', 'unconfigured'].includes(payload.mode) ? payload.mode : 'unknown',
        tester_allowlist_configured: payload.tester_allowlist_configured === true,
        plans: {},
      };
      for (const plan of ['seven_day', 'monthly', 'yearly']) {
        const row = payload.plans?.[plan];
        summary.plans[plan] = Object.fromEntries(
          ['configured', 'approved_url_matches', 'verification_hash_matches', 'ready']
            .map(key => [key, row?.[key] === true]),
        );
      }
      console.log(JSON.stringify(summary, null, 2));
      if (summary.mode !== 'test' || !Object.values(summary.plans).every(row => row.ready)) {
        process.exitCode = 2;
      }
    }
  } catch {
    console.error('Read-only runtime check failed; no credentials or provider response logged.');
    process.exitCode = 1;
  }
}