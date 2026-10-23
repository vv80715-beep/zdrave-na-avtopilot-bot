const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');
const { createClaim, verifyClaim, CLAIM_PATH } = require('../miniAppBridgeAuth');
const { createMiniAppBridgeRouter } = require('../miniAppBridge');
const { createMiniAppSnapshotReader } = require('../miniAppReadModel');

const SECRET = 'synthetic-bridge-secret-at-least-32-characters';
const NOW = 1_800_000_000;
const OWNER = '123456789';
const CLIENT_ONE = '987654321';
const CLIENT_TWO = '876543219';

async function listen(readSnapshot) {
  const app = express();
  app.use(express.json());
  app.use(createMiniAppBridgeRouter({
    secret: SECRET,
    now: () => NOW,
    readSnapshot,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  return {
    request(token, body = {}) {
      return fetch(`http://127.0.0.1:${address.port}${CLAIM_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    },
    close() {
      return new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve()));
    },
  };
}

test('internal bridge requires valid short-lived signed claims and rejects replay', async () => {
  let calls = 0;
  const server = await listen(async userId => {
    calls += 1;
    return { owner: userId === OWNER, userId };
  });
  try {
    assert.equal((await server.request('invalid')).status, 401);
    const expired = createClaim(CLIENT_ONE, SECRET, NOW - 31);
    assert.equal((await server.request(expired)).status, 401);

    const token = createClaim(CLIENT_ONE, SECRET, NOW);
    assert.deepEqual(verifyClaim(token, SECRET, NOW), {
      userId: CLIENT_ONE,
      nonce: verifyClaim(token, SECRET, NOW).nonce,
      path: CLAIM_PATH,
    });
    const response = await server.request(token, { userId: OWNER });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      snapshot: { owner: false, userId: CLIENT_ONE },
    });
    assert.equal((await server.request(token)).status, 401);
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});

test('legacy read model scopes all source stores to verified subject and dossier to owner only', async () => {
  const calls = [];
  const reader = createMiniAppSnapshotReader({
    getUser: id => (calls.push(['profile', id]), { id }),
    getMemory: id => (calls.push(['memory', id]), { id }),
    getUserMemories: id => (calls.push(['relationship', id]), []),
    getHealthLogs: id => (calls.push(['health', id]), []),
    getCheckins: id => (calls.push(['checkins', id]), []),
    getReminders: id => (calls.push(['reminders', id]), []),
    getMode: id => (calls.push(['mode', id]), 'text'),
    resolveAccessStatus: async ctx => {
      const id = String(ctx.from.id);
      calls.push(['entitlement', id]);
      return {
        plan: 'free', state: 'trial_expired', allowedModes: [], canChat: false,
        planExpiresAt: null, trialExpiresAt: null, backendVerified: true,
      };
    },
    isOwnerId: id => id === OWNER,
    getOwnerDossierEntries: id => (calls.push(['dossier', id]), [{ id: 'synthetic-owner-only' }]),
  });

  const owner = await reader(OWNER);
  const one = await reader(CLIENT_ONE);
  const two = await reader(CLIENT_TWO);
  assert.equal(owner.ownerDossier.length, 1);
  assert.equal(Object.hasOwn(one, 'ownerDossier'), false);
  assert.equal(Object.hasOwn(two, 'ownerDossier'), false);
  assert.equal(one.entitlement.state, 'trial_expired');
  assert.deepEqual(one.checkins, []);
  assert.deepEqual(one.healthLogs, []);
  for (const [, id] of calls) assert.ok([OWNER, CLIENT_ONE, CLIENT_TWO].includes(id));
  assert.equal(calls.filter(([source]) => source === 'dossier').length, 1);
  await assert.rejects(reader('not-a-telegram-id'), /mini_app_user_invalid/);
});
