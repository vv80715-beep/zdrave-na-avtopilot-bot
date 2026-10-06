import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, MESSAGE, RENEW_URL } from "./worker.mjs";

const secret = "s".repeat(40);
const date = "2025-01-01T00:00:00Z";
const request = (authorization = `Bearer ${secret}`, method = "POST", path = "") =>
  new Request(`https://example.test/functions/v1/subscription-expiry${path}`, {
    method, headers: { authorization },
  });
const success = { status: 200, body: { ok: true, result: { message_id: 123 } } };
const identity = { status: 200, body: { ok: true, result: { username: "EliZdraveBot" } } };

// Persistent shared store. A claim acquires a lease; begin rechecks the
// entitlement generation. Only processing can be reclaimed, never sending.
function database(rows = [{ id: "row1", telegram_user_id: "123456789", period_start: date,
  expires_at: date, plan_id: "monthly", status: "pending", lease_token: "lease1" }]) {
  const db = { rows, calls: [], failAck: 0, onBegin: null };
  db.createStore = () => ({
    expireDue: async ({ p_limit }) => {
      db.calls.push(["expireDue", p_limit]);
      assert.equal(p_limit, 100);
      return rows.length;
    },
    claim: async () => {
      db.calls.push(["claim"]);
      const row = rows.find((item) => item.status === "pending");
      if (!row) return null;
      row.status = "processing";
      return { id: row.id, lease_token: row.lease_token,
        telegram_user_id: row.telegram_user_id, plan_id: row.plan_id,
        period_start: row.period_start, expires_at: row.expires_at };
    },
    begin: async ({ p_id, p_lease }) => {
      db.calls.push(["begin", p_id, p_lease]);
      if (db.onBegin) await db.onBegin();
      const row = rows.find((item) => item.id === p_id && item.lease_token === p_lease);
      if (!row || row.status !== "processing" || row.renewed) return false;
      row.status = "sending";
      return true;
    },
    finish: async (args) => {
      db.calls.push(["finish", args]);
      if (db.failAck-- > 0) throw new Error("database down");
      const row = rows.find((item) => item.id === args.p_id && item.lease_token === args.p_lease);
      if (!row || row.status !== "sending") return false;
      row.status = args.p_status;
      row.ack = args;
      return true;
    },
  });
  return db;
}
function setup(db = database(), overrides = {}) {
  const sent = [];
  let identities = 0;
  const deps = {
    secret, botToken: "fake-bot-token",
    createStore: db.createStore,
    getMe: async (_token, timeout) => {
      identities++;
      assert.equal(timeout, 8000);
      return identity;
    },
    sendMessage: async (_token, payload, timeout) => {
      sent.push(payload);
      assert.ok(timeout > 0 && timeout <= 10_000);
      return success;
    },
    ...overrides,
  };
  return { db, sent, deps, get identities() { return identities; },
    run: async (req = request()) => {
      const response = await handleRequest(req, deps);
      return { status: response.status, body: await response.json() };
    } };
}

test("exact message, one button, lease-qualified success; repeated runs and new worker instance do not resend", async () => {
  const db = database();
  const first = setup(db);
  assert.equal((await first.run()).body.sent, 1);
  assert.deepEqual(first.sent, [{
    chat_id: "123456789", text: MESSAGE,
    reply_markup: { inline_keyboard: [[{ text: "Renew subscription", url: RENEW_URL }]] },
  }]);
  assert.equal(db.rows[0].ack.p_message_id, 123);
  assert.equal(db.rows[0].ack.p_lease, "lease1");
  assert.equal((await setup(db).run()).body.sent, 0);
  assert.equal(db.rows[0].status, "sent");
});

test("concurrent workers against the same store send once", async () => {
  const db = database();
  const a = setup(db);
  const b = setup(db);
  await Promise.all([a.run(), b.run()]);
  assert.equal(a.sent.length + b.sent.length, 1);
});

test("one invocation processes at most ten claims sequentially", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: `row${i}`, telegram_user_id: "123456789", period_start: date,
    expires_at: date, plan_id: "monthly", status: "pending", lease_token: `lease${i}`,
  }));
  const worker = setup(database(rows));
  const result = await worker.run();
  assert.equal(result.body.claimed, 10);
  assert.equal(result.body.sent, 10);
  assert.equal(worker.sent.length, 10);
  assert.equal(rows.filter((row) => row.status === "pending").length, 2);
});

test("failed ack after successful Telegram delivery retries ack only, then remains sending after restart", async () => {
  const db = database();
  db.failAck = 2;
  const a = setup(db);
  const result = await a.run();
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "ack_unavailable");
  assert.equal(a.sent.length, 1);
  assert.equal(db.rows[0].status, "sending");
  const b = setup(db);
  assert.equal((await b.run()).body.sent, 0);
  assert.equal(b.sent.length, 0);
  assert.equal(db.calls.filter(([name]) => name === "finish").length, 2);
});

test("single transient ack failure retries same sent ack, not Telegram", async () => {
  const db = database();
  db.failAck = 1;
  const worker = setup(db);
  assert.equal((await worker.run()).body.sent, 1);
  assert.equal(worker.sent.length, 1);
  assert.equal(db.calls.filter(([name]) => name === "finish").length, 2);
});

test("renewal and reactivation before send invalidate begin", async () => {
  for (const change of ["renewal", "reactivation"]) {
    const db = database();
    db.onBegin = () => {
      db.rows[0].renewed = true;
      db.rows[0].period_start = change === "renewal" ? "2025-02-01T00:00:00Z" : date;
    };
    const worker = setup(db);
    const result = await worker.run();
    assert.equal(result.body.skipped, 1);
    assert.equal(worker.sent.length, 0);
    assert.equal(db.calls.some(([name]) => name === "finish"), false);
  }
});

test("wrong identity, unavailable identity and unauthorized requests never touch DB or send", async () => {
  const db = database();
  const worker = setup(db, { getMe: async () => ({
    status: 200, body: { ok: true, result: { username: "ImposterBot" } },
  }) });
  assert.equal((await worker.run()).status, 503);
  assert.deepEqual(db.calls, []);
  assert.equal(worker.sent.length, 0);
  const offline = setup(db, { getMe: async () => { throw Error("timeout"); } });
  assert.equal((await offline.run()).body.error, "bot_identity_unavailable");
  const forbidden = setup(db);
  for (const header of [undefined, "Bearer wrong", `bearer ${secret}`, `Bearer ${secret}x`]) {
    assert.equal((await forbidden.run(request(header ?? "", "POST"))).status, 401);
  }
  assert.equal(forbidden.identities, 0);
  assert.deepEqual(db.calls, []);
  const unconfigured = setup(db, { secret: "short" });
  assert.equal((await unconfigured.run()).status, 401);
  assert.deepEqual(db.calls, []);
});

test("health is authenticated and read-only; non-POST methods are rejected", async () => {
  const worker = setup();
  assert.equal((await worker.run(request(`Bearer ${secret}`, "GET", "/health"))).status, 200);
  assert.equal((await worker.run(request("", "GET", "/health"))).status, 401);
  assert.equal((await worker.run(request(`Bearer ${secret}`, "GET"))).status, 405);
  assert.equal((await worker.run(request(`Bearer ${secret}`, "PUT"))).status, 405);
  assert.equal(worker.identities, 0);
  assert.deepEqual(worker.db.calls, []);
});

test("429 is retry with bounded retry-after; 400 and 403 known rejections fail", async () => {
  for (const [status, expected] of [[429, "retry"], [400, "failed"], [403, "failed"]]) {
    const worker = setup(database(), { sendMessage: async () => ({
      status, body: { ok: false, error_code: status, parameters: { retry_after: 90000 } },
    }) });
    assert.equal((await worker.run()).body[expected], 1);
    assert.equal(worker.db.rows[0].status, expected);
    if (status === 429) assert.equal(worker.db.rows[0].ack.p_retry_after, 3600);
  }
});

test("timeout, network errors, malformed response and 5xx become uncertain, not retried on restart", async () => {
  const outcomes = [
    async () => { throw new Error("timeout"); },
    async () => { throw new Error("network"); },
    async () => ({ status: 200, body: { ok: true, result: {} } }),
    async () => ({ status: 502, body: { ok: false, error_code: 502 } }),
  ];
  for (const sendMessage of outcomes) {
    const db = database();
    const worker = setup(db, { sendMessage });
    assert.equal((await worker.run()).body.uncertain, 1);
    assert.equal(db.rows[0].status, "uncertain");
    assert.equal((await setup(db).run()).body.sent, 0);
  }
});