// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY owner-only plan testing commands.
//
// Production plan activation comes only from the Bolt backend. The OWNER (and
// only the owner — adminGuard.isOwner) can still manipulate LOCAL plan state
// for deterministic tests/diagnostics, but this cannot unlock backend-gated
// Voice or Avatar delivery.
// Ordinary users get a polite refusal and can never grant themselves plans.
// This file is intentionally isolated so it can be deleted wholesale once the
// real activation path exists.
// ─────────────────────────────────────────────────────────────────────────────

const { isOwner } = require('../adminGuard');
const {
  activatePlan,
  getStatus,
  ensureUser,
  DAY_MS,
} = require('../entitlements');

const STATES = [
  'trial',
  'trial_expired',
  'seven_day',
  'seven_day_expired',
  'monthly',
  'monthly_expired',
  'yearly',
  'yearly_expired',
];

function applyTestState(userId, state) {
  const now = Date.now();
  switch (state) {
    case 'trial':
      return activatePlan(userId, 'free', { activatedAt: now });
    case 'trial_expired':
      // Trial started 6 days ago → expired yesterday.
      return activatePlan(userId, 'free', {
        activatedAt: now - 6 * DAY_MS,
        expiresAt: now - 1 * DAY_MS,
      });
    case 'seven_day':
      return activatePlan(userId, 'seven_day');
    case 'seven_day_expired':
      return activatePlan(userId, 'seven_day', {
        activatedAt: now - 8 * DAY_MS,
        expiresAt: now - 1 * DAY_MS,
      });
    case 'monthly':
      return activatePlan(userId, 'monthly');
    case 'monthly_expired':
      return activatePlan(userId, 'monthly', {
        activatedAt: now - 31 * DAY_MS,
        expiresAt: now - 1 * DAY_MS,
      });
    case 'yearly':
      return activatePlan(userId, 'yearly');
    case 'yearly_expired':
      return activatePlan(userId, 'yearly', {
        activatedAt: now - 366 * DAY_MS,
        expiresAt: now - 1 * DAY_MS,
      });
    default:
      return null;
  }
}

function fmtDate(ts) {
  return ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '—';
}

function statusText(userId) {
  ensureUser(userId);
  const s = getStatus(userId);
  return (
    `👤 Потребител: ${userId}\n` +
    `План: ${s.plan} (състояние: ${s.state})\n` +
    `Разрешени режими: ${s.allowedModes.join(', ') || 'няма (изтекъл пробен период)'}\n` +
    `Пробен период до: ${fmtDate(s.trialExpiresAt)}\n` +
    `Платен план до: ${fmtDate(s.planExpiresAt)}`
  );
}

function register(bot) {
  bot.command('setplan', (ctx) => {
    if (!isOwner(ctx)) {
      return ctx.reply('Тази команда е достъпна само за собственика. 💙');
    }
    if (ctx.session) ctx.session.__scenes = {};
    const parts = ctx.message.text.trim().split(/\s+/);
    const state = (parts[1] || '').toLowerCase();
    const targetId = parts[2] || ctx.from.id;
    if (!STATES.includes(state)) {
      return ctx.reply(
        `Употреба: /setplan <състояние> [userId]\nСъстояния: ${STATES.join(', ')}`
      );
    }
    applyTestState(targetId, state);
    return ctx.reply(`✅ Готово.\n\n${statusText(targetId)}`);
  });

  bot.command('planstatus', (ctx) => {
    if (!isOwner(ctx)) {
      return ctx.reply('Тази команда е достъпна само за собственика. 💙');
    }
    if (ctx.session) ctx.session.__scenes = {};
    const parts = ctx.message.text.trim().split(/\s+/);
    const targetId = parts[1] || ctx.from.id;
    return ctx.reply(statusText(targetId));
  });
}

module.exports = { register, applyTestState, STATES };
