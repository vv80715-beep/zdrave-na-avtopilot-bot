const test = require('node:test');
const assert = require('node:assert/strict');
const { handleAvatarMetering } = require('../../bolt-backend/supabase/functions/avatar-metering/handler.ts');

const owner = '900000020';
const customer = '900000003';
const secret = 'offline-secret-not-used-outside-this-test';
const calls = [];
const config = (ownerId = owner) => ({
  secret, serviceKey: 'offline-service-role', ownerId,
  rpc: async (name, params, key) => {
    assert.equal(key, 'offline-service-role');
    calls.push({ name, params });
    if (name === 'avatar_owner_meter') {
      return { data: { status: 'eligible', available_seconds: 30 }, error: null };
    }
    if (name === 'avatar_allowance') {
      return { data: null, error: { message: 'avatar_plan_inactive' } };
    }
    return { data: { status: 'reserved', hold_seconds: 30 }, error: null };
  },
});
const body = (user, action = 'allowance') => ({
  action, telegram_user_id: user, request_id: `tg:${user}:12345`,
});
function request(payload, token = secret) {
  return new Request('https://offline.example/avatar-metering', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('trusted server owner ID selects separate owner RPC, never a JSON owner assertion', async () => {
  calls.length = 0;
  const res = await handleAvatarMetering(request(body(owner)), config());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'eligible', available_seconds: 30 });
  assert.deepEqual(calls, [{
    name: 'avatar_owner_meter',
    params: {
      p_user: owner, p_request: `tg:${owner}:12345`, p_action: 'allowance',
      p_video_id: null, p_duration: null, p_video_url: null,
    },
  }]);
});
test('ordinary seven-day customer remains on customer entitlement RPC', async () => {
  calls.length = 0;
  const res = await handleAvatarMetering(request(body(customer)), config());
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'avatar_plan_inactive' });
  assert.equal(calls[0].name, 'avatar_allowance');
  assert.deepEqual(calls[0].params, { p_user: customer, p_request: `tg:${customer}:12345` });
});
test('absent/malformed server owner config cannot grant owner RPC', async () => {
  for (const ownerId of [null, '', '000900000020']) {
    calls.length = 0;
    const res = await handleAvatarMetering(request(body(owner)), config(ownerId));
    assert.equal(res.status, 403);
    assert.equal(calls[0].name, 'avatar_allowance');
  }
});
test('caller-supplied owner claims, arbitrary holds, another user ID prefix, and invalid auth fail before RPC', async () => {
  const spoofed = [
    { ...body(customer), is_owner: true },
    { ...body(customer), role: 'owner' },
    { ...body(customer), owner_id: owner },
    { ...body(customer), scope: 'owner' },
    { ...body(customer, 'reserve'), hold_seconds: 1 },
    { ...body(customer), request_id: `tg:${owner}:12345` },
  ];
  for (const payload of spoofed) {
    calls.length = 0;
    const res = await handleAvatarMetering(request(payload), config());
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  }
  const rejected = await handleAvatarMetering(request(body(owner), 'wrong-bearer-token'), config());
  assert.equal(rejected.status, 401);
  assert.equal(calls.length, 0);
});
test('ordinary monthly/yearly actions retain customer RPC routing', async () => {
  for (const action of ['reserve', 'pending', 'begin', 'complete']) {
    calls.length = 0;
    const res = await handleAvatarMetering(request(body(customer, action)), config());
    assert.equal(res.status, 200);
    assert.equal(calls[0].name, action === 'reserve' ? 'avatar_reserve' :
      action === 'pending' ? 'avatar_pending' : 'avatar_transition');
  }
});