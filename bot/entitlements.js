// ─────────────────────────────────────────────────────────────────────────────
// Entitlements — the single source of truth for WHO may use WHAT.
//
// Plans:      free (5-day trial) | seven_day | monthly | yearly
// Modes:      text | voice | avatar  (allowed modes are DERIVED server-side
//             from the plan + expiry — never trusted from user input)
//
// Storage:    entitlements.json (own file, separate from all conversational
//             memory / health stores; env-overridable for tests).
//
// Future payment integration plugs in at activatePlan(userId, plan, opts) —
// a trusted website/payment webhook only needs the Telegram user id, the plan
// and (optionally) explicit activation/expiry times. Nothing else in the bot
// needs to change.
//
// Future avatar credits/quotas plug in at checkQuota(userId, feature): it runs
// AFTER entitlement authorization and BEFORE any paid provider call. The
// per-user `extras` object is the reserved home for credit balances, reset
// periods and yearly-only benefits.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const FILE =
  process.env.ENTITLEMENTS_PATH || path.join(__dirname, 'entitlements.json');

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 5;

// Server-side plan rules. Mode lists are ordered: first = default fallback.
const PLAN_RULES = {
  free: { modes: ['text'], durationDays: TRIAL_DAYS },
  seven_day: { modes: ['text', 'voice'], durationDays: 7 },
  monthly: { modes: ['text', 'voice', 'avatar'], durationDays: 30 },
  yearly: { modes: ['text', 'voice', 'avatar'], durationDays: 365 },
};

const PAID_PLANS = new Set(['seven_day', 'monthly', 'yearly']);

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (_) {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

// Creates the user's entitlement record on first contact: a 5-day free trial.
// Idempotent — an existing record (including an expired one) is NEVER reset,
// so a paid-plan expiry or a re-/start can't grant a fresh trial.
function ensureUser(userId, now = Date.now()) {
  const data = load();
  const key = String(userId);
  if (!data[key]) {
    data[key] = {
      plan: 'free',
      planActivatedAt: null,
      planExpiresAt: null,
      trialStartedAt: now,
      trialExpiresAt: now + TRIAL_DAYS * DAY_MS,
      expiryNoticeSent: false,
      extras: {}, // reserved: avatar credits, quotas, yearly-only benefits
    };
    save(data);
  }
  return data[key];
}

// Local activation path for owner/admin testing only. Customer purchases are
// fulfilled by the Bolt backend and must never call this function.
function activatePlan(userId, plan, { activatedAt, expiresAt } = {}) {
  if (!PLAN_RULES[plan]) throw new Error(`Unknown plan: ${plan}`);
  const data = load();
  const key = String(userId);
  const rec = data[key] || ensureUser(userId) || load()[key];
  const startedAt = activatedAt ?? Date.now();
  const record = { ...(data[key] || rec) };
  if (plan === 'free') {
    // Explicit trial (re)set — admin/testing only; real trials come from
    // ensureUser and are never reset implicitly.
    record.plan = 'free';
    record.planActivatedAt = null;
    record.planExpiresAt = null;
    record.trialStartedAt = startedAt;
    record.trialExpiresAt =
      expiresAt ?? startedAt + PLAN_RULES.free.durationDays * DAY_MS;
  } else {
    record.plan = plan;
    record.planActivatedAt = startedAt;
    record.planExpiresAt =
      expiresAt ?? startedAt + PLAN_RULES[plan].durationDays * DAY_MS;
  }
  record.expiryNoticeSent = false;
  record.extras = record.extras || {};
  data[key] = record;
  save(data);
  // A plan change is a fresh start: if the stored chat mode is no longer
  // covered by the NEW plan, reset it to text NOW — silently. Otherwise the
  // gate would later see the stale premium mode and emit a misleading
  // "премиум достъпът ти изтече" notice on a perfectly valid new plan.
  // (Lazy require: avatarModeStorage is standalone, but keep load order safe.)
  try {
    const { getMode, setMode } = require('./avatarModeStorage');
    const allowed = plan === 'free' ? PLAN_RULES.free.modes : PLAN_RULES[plan].modes;
    if (!allowed.includes(getMode(userId))) setMode(userId, 'text');
  } catch (err) {
    console.error('Mode reset on plan change failed:', err.message);
  }
  // Owner/admin test transitions must not leave a stale effective-status cache.
  // This clears only in-memory lookup state; it never grants backend access.
  try {
    require('./entitlementResolver').clearEntitlementCache(userId);
  } catch (_) {
    /* resolver may still be loading */
  }
  return record;
}

// Derived, server-side status. states:
//   'trial'         — free trial active → text only
//   'trial_expired' — trial over, no active paid plan → NO AI chat (static msg)
//   'paid'          — active paid plan → plan's modes
//   'paid_expired'  — paid plan ran out → falls back to trial state rules
function getStatus(userId, now = Date.now()) {
  const rec = ensureUser(userId, now);
  if (PAID_PLANS.has(rec.plan) && rec.planExpiresAt && now < rec.planExpiresAt) {
    return {
      plan: rec.plan,
      state: 'paid',
      allowedModes: [...PLAN_RULES[rec.plan].modes],
      canChat: true,
      planExpiresAt: rec.planExpiresAt,
      trialExpiresAt: rec.trialExpiresAt,
    };
  }
  const paidExpired = PAID_PLANS.has(rec.plan);
  // No active paid plan → the ORIGINAL trial window decides (a paid expiry can
  // never mint a new trial: trialStartedAt/trialExpiresAt are set exactly once).
  const trialActive = rec.trialExpiresAt && now < rec.trialExpiresAt;
  if (trialActive) {
    return {
      plan: 'free',
      state: paidExpired ? 'paid_expired' : 'trial',
      allowedModes: [...PLAN_RULES.free.modes],
      canChat: true,
      planExpiresAt: null,
      trialExpiresAt: rec.trialExpiresAt,
    };
  }
  return {
    plan: 'free',
    state: paidExpired ? 'paid_expired' : 'trial_expired',
    allowedModes: [],
    canChat: false,
    planExpiresAt: null,
    trialExpiresAt: rec.trialExpiresAt,
  };
}

function isModeAllowed(userId, mode, now = Date.now()) {
  return getStatus(userId, now).allowedModes.includes(mode);
}

// One-time expiry notice bookkeeping (avoid spamming the static notice).
function shouldSendExpiryNotice(userId) {
  const data = load();
  const rec = data[String(userId)];
  return !!rec && !rec.expiryNoticeSent;
}

function markExpiryNoticeSent(userId) {
  const data = load();
  const key = String(userId);
  if (data[key]) {
    data[key].expiryNoticeSent = true;
    save(data);
  }
}

// Future quota hook: runs AFTER entitlement authorization, BEFORE the paid
// provider call (TTS/HeyGen). Today every authorized request is allowed; the
// avatar-credit system will read/deduct from `extras` here — one place only.
function checkQuota(userId, feature) {
  void userId;
  void feature;
  return { allowed: true };
}

module.exports = {
  ensureUser,
  activatePlan,
  getStatus,
  isModeAllowed,
  shouldSendExpiryNotice,
  markExpiryNoticeSent,
  checkQuota,
  PLAN_RULES,
  TRIAL_DAYS,
  DAY_MS,
};
