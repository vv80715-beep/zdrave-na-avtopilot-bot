const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('Mini App entitlement status does not create or modify trial records', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-readonly-entitlement-'));
  const file = path.join(root, 'entitlements.json');
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { resolveReadOnlyAccessStatus } = require('./bot/chatGate');
    const { _setPlatformClientForTests } = require('./bot/entitlementResolver');
    const userId = '987654321';
    const now = 1_800_000_000_000;
    _setPlatformClientForTests({ getEntitlement: async () => ({ entitlement: null }) });
    (async () => {
      const uninitialized = await resolveReadOnlyAccessStatus({ from: { id: userId } }, { now });
      assert.equal(uninitialized.state, 'trial_not_started');
      assert.equal(uninitialized.backendVerified, true);
      assert.equal(fs.existsSync(process.env.ENTITLEMENTS_PATH), false);

      const fixture = {
        [userId]: {
          plan: 'free', trialStartedAt: now - 1000, trialExpiresAt: now + 86400000,
        },
      };
      const bytes = JSON.stringify(fixture, null, 2);
      fs.writeFileSync(process.env.ENTITLEMENTS_PATH, bytes);
      const activeTrial = await resolveReadOnlyAccessStatus({ from: { id: userId } }, { now });
      assert.equal(activeTrial.state, 'trial');
      assert.equal(activeTrial.backendVerified, true);
      assert.equal(fs.readFileSync(process.env.ENTITLEMENTS_PATH, 'utf8'), bytes);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  try {
    execFileSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        ENTITLEMENTS_PATH: file,
        OWNER_TELEGRAM_ID: '123456789',
      },
      stdio: 'pipe',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
