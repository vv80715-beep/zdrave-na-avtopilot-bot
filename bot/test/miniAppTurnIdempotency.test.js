'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMiniAppTurnCoordinator } = require('../miniAppTurnIdempotency');

const TURN = 'f9b2d7a0-0e22-4e10-a987-7eea4ebf0667';

test('same user, turn ID, and payload shares one in-flight or completed result', async () => {
  let calls = 0;
  let finish;
  const coordinator = createMiniAppTurnCoordinator();
  const work = () => { calls += 1; return new Promise(resolve => { finish = resolve; }); };
  const first = coordinator({ userId: '987654321', turnId: TURN, fingerprint: 'voice:hash', work });
  const duplicate = coordinator({ userId: '987654321', turnId: TURN, fingerprint: 'voice:hash', work });
  assert.strictEqual(first, duplicate);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish({ reply: 'cached synthetic response' });
  assert.deepEqual(await first, { reply: 'cached synthetic response' });
  assert.deepEqual(await coordinator({
    userId: '987654321', turnId: TURN, fingerprint: 'voice:hash',
    work: async () => { calls += 1; return { reply: 'duplicate' }; },
  }), { reply: 'cached synthetic response' });
  assert.equal(calls, 1);
});

test('same turn ID with different payload is rejected and never processed twice', async () => {
  const coordinator = createMiniAppTurnCoordinator();
  let calls = 0;
  await coordinator({ userId: '987654321', turnId: TURN, fingerprint: 'text:one', work: async () => ++calls });
  await assert.rejects(coordinator({
    userId: '987654321', turnId: TURN, fingerprint: 'text:two', work: async () => ++calls,
  }), error => error.code === 'turn_id_conflict');
  assert.equal(calls, 1);
});
