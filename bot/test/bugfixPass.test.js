// Offline regression tests for the V1 bug-fix pass (4 bugs). No network calls.
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-bugfix-test-'));
process.env.DAILY_LOG_PATH = path.join(tmp, 'daily_logs.json');
process.env.ENTITLEMENTS_PATH = path.join(tmp, 'entitlements.json');
process.env.AVATAR_MODE_PATH = path.join(tmp, 'avatar_mode.json');
process.env.AVATAR_LOOK_PATH = path.join(tmp, 'avatar_looks.json');

const test = require('node:test');
const assert = require('node:assert');

const { matchCategoryQuery, isAdviceRequest } = require('../dailyLogQuery');
const { extractHealthEvents } = require('../dailyLogTracker');
const {
  resolveLogQuery,
  answerDailyLogQuery,
  recordEvents,
} = require('../dailyLogService');
const { activatePlan, ensureUser, getStatus } = require('../entitlements');
const { applyTestState } = require('../commands/planAdmin');
const { getMode, setMode } = require('../avatarModeStorage');
const { gateChat, TRIAL_EXPIRED_MESSAGE } = require('../chatGate');
const { _setPlatformClientForTests } = require('../entitlementResolver');
const {
  ownerRecentTurns,
  ownerRememberTurn,
  clearOwnerTurns,
  OWNER_TURN_CAP,
} = require('../ownerSession');

_setPlatformClientForTests({
  getEntitlement: async (id) => {
    const status = getStatus(id);
    const rec = ensureUser(id);
    return {
      entitlement:
        status.state === 'paid'
          ? {
              telegram_user_id: String(id),
               active: true,
              plan_id: status.plan,
              status: 'active',
               billing_status: 'active',
               starts_at: new Date(Date.now() - 1000).toISOString(),
              expires_at: new Date(status.planExpiresAt).toISOString(),
              modes: status.allowedModes,
            }
          : status.state === 'paid_expired'
            ? {
                telegram_user_id: String(id),
                 active: false,
                plan_id: rec.plan,
                status: 'expired',
                 billing_status: 'active',
                 starts_at: new Date(rec.planActivatedAt).toISOString(),
                expires_at: new Date(rec.planExpiresAt).toISOString(),
                 modes: [],
              }
            : null,
    };
  },
});

// ── BUG 1: "стъпки" as instructions vs. pedometer data ──────────────────────

test('how-to "стъпки" requests are NOT routed to the steps tracker', () => {
  const advice = [
    'Ели, дай ми 3 кратки стъпки как да започна деня си по-организирано.',
    'дай ми 3 стъпки как да спя по-добре',
    'Какви стъпки да предприема, за да отслабна?',
    'Кажи ми стъпки за по-спокойна сутрин',
    'Какви са първите стъпки към по-здравословен живот?',
    'Дай ми съвет с няколко стъпки как да пия повече вода.',
  ];
  for (const q of advice) {
    assert.ok(isAdviceRequest(q), `should be advice: ${q}`);
    assert.strictEqual(resolveLogQuery(q), null, `should not be a log query: ${q}`);
  }
});

test('advice phrasing with a number never records fake physical steps', () => {
  for (const q of [
    'дай ми 3 стъпки как да се организирам',
    'какви 5 стъпки да предприема?',
  ]) {
    const events = extractHealthEvents(q);
    assert.ok(!events.some((e) => e.category === 'steps'), `no steps event for: ${q}`);
  }
});

test('explicit data intent overrides an advice clause in the same message', () => {
  // Recall wrapped in a how-to phrase is still a deterministic data query.
  const q = resolveLogQuery('Как да проверя колко вода изпих днес?');
  assert.ok(q && q.kind === 'category');
  assert.deepStrictEqual(q.categories, ['water']);
  // A real report followed by an advice question still records the steps.
  const events = extractHealthEvents(
    'Днес направих 8000 стъпки, как да подобря резултата си'
  );
  assert.ok(events.some((e) => e.category === 'steps' && e.amount === 8000));
});

test('real step reports and step data queries still work', () => {
  assert.ok(
    extractHealthEvents('Ели, днес направих 8000 стъпки.').some(
      (e) => e.category === 'steps' && e.amount === 8000
    )
  );
  const q = resolveLogQuery('Колко стъпки направих днес?');
  assert.strictEqual(q.kind, 'category');
  assert.deepStrictEqual(q.categories, ['steps']);
});

// ── BUG 2: multi-metric recall queries ───────────────────────────────────────

const U = 801;
recordEvents(U, extractHealthEvents('направих 8000 стъпки'));
recordEvents(U, extractHealthEvents('изпих 2 литра вода'));
recordEvents(U, extractHealthEvents('спах 7 часа'));

test('single-metric query still returns exactly that metric', () => {
  const q = resolveLogQuery('Колко вода изпих днес?');
  assert.deepStrictEqual(q.categories, ['water']);
  const a = answerDailyLogQuery(U, q);
  assert.ok(a.includes('2 литра') || a.includes('2 л'));
  assert.ok(!a.includes('Стъпки'));
});

test('two-metric query answers both', () => {
  const q = resolveLogQuery('Какво ти казах днес за водата и съня ми?');
  assert.deepStrictEqual([...q.categories].sort(), ['sleep', 'water']);
  const a = answerDailyLogQuery(U, q);
  assert.ok(/8000/.test(a) === false); // steps not requested
  assert.ok(a.includes('7'));
  assert.ok(a.includes('2'));
});

test('three-metric query answers all three in one coherent reply', () => {
  const q = resolveLogQuery('Ели, какво ти казах днес за водата, стъпките и съня ми?');
  assert.deepStrictEqual([...q.categories].sort(), ['sleep', 'steps', 'water']);
  const a = answerDailyLogQuery(U, q);
  assert.ok(a.includes('8000'), 'steps included');
  assert.ok(a.includes('2'), 'water included');
  assert.ok(a.includes('7'), 'sleep included');
});

test('requested metric with no stored value gets a clear no-data line', () => {
  const empty = 802;
  const a = answerDailyLogQuery(empty, resolveLogQuery('Колко стъпки направих днес?'));
  assert.ok(a.includes('Няма записани данни'));
});

test('mixed available + unavailable metrics: values AND no-data lines', () => {
  const half = 803;
  recordEvents(half, extractHealthEvents('спах 6 часа'));
  const q = resolveLogQuery('какво знаеш за съня и стъпките ми днес?');
  const a = answerDailyLogQuery(half, q);
  assert.ok(a.includes('6'), 'stored sleep shown');
  assert.ok(a.includes('Няма записани данни'), 'missing steps acknowledged');
});

// ── BUG 3: stale premium/expiry notice after plan-state change ───────────────

function fakeCtx(id) {
  const sent = [];
  return {
    from: { id },
    reply: async (text) => sent.push(text),
    sent,
  };
}

test('premium → trial reset: mode drops to text, NO stale expiry notice', async () => {
  const id = 811;
  activatePlan(id, 'monthly');
  setMode(id, 'avatar');
  applyTestState(id, 'trial');
  assert.strictEqual(getMode(id), 'text'); // reset at plan change, silently
  const status = await gateChat(fakeCtx(id));
  assert.ok(status && status.canChat);
  assert.strictEqual(status.notice, null);
});

test('trial_expired → trial: chat allowed again, no notice', async () => {
  const id = 812;
  applyTestState(id, 'trial_expired');
  const blocked = await gateChat(fakeCtx(id));
  assert.strictEqual(blocked, null);
  applyTestState(id, 'trial');
  const status = await gateChat(fakeCtx(id));
  assert.ok(status && status.canChat);
  assert.strictEqual(status.notice, null);
});

test('paid → another paid plan: silent mode adjustment, no expiry notice', async () => {
  const id = 813;
  activatePlan(id, 'monthly');
  setMode(id, 'avatar');
  applyTestState(id, 'seven_day'); // avatar not allowed on seven_day
  assert.strictEqual(getMode(id), 'text');
  const status = await gateChat(fakeCtx(id));
  assert.strictEqual(status.notice, null);
  assert.ok(status.allowedModes.includes('voice'));
});

test('genuine paid expiry resets stale mode without a chat notice or consuming legacy notice state', async () => {
  const id = 814;
  applyTestState(id, 'monthly_expired'); // mode stays whatever it was
  setMode(id, 'avatar'); // stale premium mode from the expired plan
  const ctx = fakeCtx(id);
  const first = await gateChat(ctx);
  assert.strictEqual(first.state, 'paid_expired');
  assert.strictEqual(first.canChat, true); // original trial is still active
  assert.strictEqual(first.notice, null);
  assert.strictEqual(getMode(id), 'text');
  assert.deepStrictEqual(ctx.sent, []);
  assert.strictEqual(ensureUser(id).expiryNoticeSent, false);
  const second = await gateChat(fakeCtx(id));
  assert.strictEqual(second.notice, null);
});

test('paid expiry after the original trial blocks chat with the existing static trial message', async () => {
  const id = 816;
  applyTestState(id, 'trial_expired');
  applyTestState(id, 'monthly_expired');
  setMode(id, 'avatar');
  const ctx = fakeCtx(id);
  assert.strictEqual(await gateChat(ctx), null);
  assert.deepStrictEqual(ctx.sent, [TRIAL_EXPIRED_MESSAGE]);
  assert.strictEqual(getMode(id), 'avatar'); // blocked before mode reset, as before
});

test('after a genuine expiry, a NEW valid plan keeps its allowed mode without a notice', async () => {
  const id = 815;
  applyTestState(id, 'monthly_expired');
  setMode(id, 'avatar');
  await gateChat(fakeCtx(id)); // mode reset, no chat notice
  applyTestState(id, 'monthly'); // resubscribed
  setMode(id, 'avatar');
  const status = await gateChat(fakeCtx(id));
  assert.strictEqual(status.notice, null);
  assert.strictEqual(getMode(id), 'avatar'); // allowed again, untouched
});

// ── BUG 4: owner conversational context between consecutive messages ─────────

test('owner session turns are kept in order and returned as chat messages', () => {
  clearOwnerTurns(901);
  ownerRememberTurn(901, 'user', 'Искам утре сутрин да тренирам 20 минути.');
  ownerRememberTurn(901, 'assistant', 'Какъв тип тренировка имаш предвид?');
  const turns = ownerRecentTurns(901);
  assert.strictEqual(turns.length, 2);
  assert.deepStrictEqual(turns[0], {
    role: 'user',
    content: 'Искам утре сутрин да тренирам 20 минути.',
  });
  assert.strictEqual(turns[1].role, 'assistant');
});

test('owner buffer caps at OWNER_TURN_CAP and keeps the newest turns', () => {
  clearOwnerTurns(902);
  for (let i = 0; i < OWNER_TURN_CAP + 6; i++) {
    ownerRememberTurn(902, i % 2 ? 'assistant' : 'user', `msg ${i}`);
  }
  const turns = ownerRecentTurns(902);
  assert.strictEqual(turns.length, OWNER_TURN_CAP);
  assert.strictEqual(turns[turns.length - 1].content, `msg ${OWNER_TURN_CAP + 5}`);
});

test('owner buffer is per-user and RAM-only (no file writes)', () => {
  clearOwnerTurns(903);
  ownerRememberTurn(903, 'user', 'здравей');
  assert.strictEqual(ownerRecentTurns(904).length, 0);
  // Nothing owner-related lands in the tmp storage dir.
  const files = fs.readdirSync(tmp).join(',');
  assert.ok(!files.includes('owner'));
});

test.after(() => {
  for (const f of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, f));
  fs.rmdirSync(tmp);
});
