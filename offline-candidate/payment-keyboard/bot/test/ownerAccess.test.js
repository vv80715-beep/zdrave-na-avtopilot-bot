// Offline regression tests for owner/admin precedence over customer gating.
// No network, purchase-session, payment, TTS, or avatar provider calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-owner-access-test-'));
const ownerId = String(9_000_000 + process.pid);
const ordinaryId = String(Number(ownerId) + 1);

process.env.OWNER_TELEGRAM_ID = ownerId;
process.env.ENTITLEMENTS_PATH = path.join(tmp, 'entitlements.json');
process.env.AVATAR_MODE_PATH = path.join(tmp, 'avatar-mode.json');

const { isOwner, isOwnerId } = require('../adminGuard');
const {
  gateChat,
  resolveAccessStatus,
  OWNER_ALLOWED_MODES,
  TRIAL_EXPIRED_MESSAGE,
} = require('../chatGate');
const {
  _setPlatformClientForTests,
  clearEntitlementCache,
} = require('../entitlementResolver');
const { ensureUser, DAY_MS } = require('../entitlements');
const plans = require('../commands/plans');
const ownerCommand = require('../commands/owner');
const { PLANS_TEXT } = require('../planLinks');

function fakeCtx(id, text = '') {
  const replies = [];
  return {
    from: { id, first_name: 'Тест' },
    message: { text },
    session: {},
    replies,
    reply: async (message, extra) => {
      replies.push({ message, extra });
    },
  };
}

function fakeBot() {
  return {
    commands: new Map(),
    actions: new Map(),
    command(name, handler) {
      this.commands.set(name, handler);
    },
    action(name, handler) {
      this.actions.set(name, handler);
    },
  };
}

test.after(() => {
  _setPlatformClientForTests(null);
  clearEntitlementCache();
  for (const file of fs.readdirSync(tmp)) {
    try { fs.unlinkSync(path.join(tmp, file)); } catch (_) {}
  }
  try { fs.rmdirSync(tmp); } catch (_) {}
});

test('only the already configured owner identity is recognized', () => {
  assert.equal(isOwner(fakeCtx(ownerId)), true);
  assert.equal(isOwnerId(ownerId), true);
  assert.equal(isOwner(fakeCtx(ordinaryId)), false);
  assert.equal(isOwnerId(ordinaryId), false);
});

test('configured owner is resolved before expired-trial and backend entitlement checks', async () => {
  ensureUser(ownerId, Date.now() - 10 * DAY_MS);
  let backendCalls = 0;
  _setPlatformClientForTests({
    getEntitlement: async () => {
      backendCalls += 1;
      throw new Error('owner must not enter customer entitlement resolution');
    },
  });

  const ctx = fakeCtx(ownerId);
  const status = await gateChat(ctx);
  assert.equal(status.state, 'owner');
  assert.equal(status.canChat, true);
  assert.deepEqual(status.allowedModes, [...OWNER_ALLOWED_MODES]);
  assert.equal(status.notice, null);
  assert.equal(ctx.replies.length, 0);
  assert.equal(backendCalls, 0);
});

test('ordinary expired user is not elevated and remains customer-gated', async () => {
  ensureUser(ordinaryId, Date.now() - 10 * DAY_MS);
  _setPlatformClientForTests({
    getEntitlement: async () => ({ entitlement: null }),
  });
  clearEntitlementCache(ordinaryId);

  const ctx = fakeCtx(ordinaryId);
  const status = await gateChat(ctx);
  assert.equal(status, null);
  assert.equal(ctx.replies.length, 1);
  assert.equal(ctx.replies[0].message, TRIAL_EXPIRED_MESSAGE);
});

test('owner and normal /plans commands still run after the local trial would be expired', async () => {
  const bot = fakeBot();
  ownerCommand.register(bot);
  plans.register(bot, {
    client: {
      createPurchaseSession: async () =>
        assert.fail('displaying plans must not create a purchase session'),
    },
  });

  const ownerCtx = fakeCtx(ownerId, '/owner');
  await bot.commands.get('owner')(ownerCtx);
  assert.match(ownerCtx.replies[0].message, /собственик/);

  const plansCtx = fakeCtx(ownerId, '/plans');
  const access = await resolveAccessStatus(plansCtx);
  assert.equal(access.state, 'owner');
  await bot.commands.get('plans')(plansCtx);
  assert.equal(plansCtx.replies[0].message, PLANS_TEXT);
  assert.equal(
    plansCtx.replies.some(({ message }) => message === TRIAL_EXPIRED_MESSAGE),
    false
  );
});

test('ordinary user cannot invoke owner command', async () => {
  const bot = fakeBot();
  ownerCommand.register(bot);
  const ctx = fakeCtx(ordinaryId, '/owner');
  await bot.commands.get('owner')(ctx);
  assert.equal(ctx.replies[0].message, 'Нямаш достъп до тази команда.');
});