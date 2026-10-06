// ─────────────────────────────────────────────────────────────────────────────
// Reusable entitlement gate for EVERY OpenAI-producing entry point (free chat,
// /ask, voice input, coach commands, /plan). Runs BEFORE any paid work.
//
// Returns the user's status when chat is allowed, or null after sending the
// static expired-trial message (no AI call, no cost). Also auto-resets a
// premium mode the entitlement no longer covers (plan expired mid-session,
// stale keyboard, replayed update).
// ─────────────────────────────────────────────────────────────────────────────

const { ensureUser } = require('./entitlements');
const { resolveEntitlementStatus } = require('./entitlementResolver');
const { getMode, setMode } = require('./avatarModeStorage');
const { planKeyboard } = require('./planLinks');
const { isOwner } = require('./adminGuard');

const OWNER_ALLOWED_MODES = Object.freeze(['text', 'voice', 'avatar']);

// Static message for an expired free trial — NEVER an AI call.
const TRIAL_EXPIRED_MESSAGE =
  'Безплатният ти пробен период с Ели приключи. 💙 Благодаря, че опита!\n\n' +
  'Ако искаш да продължим заедно — с текст, глас или видео аватар — можеш да избереш план:';

// Paid-expiry notices are delivered by the subscription expiry outbox, not
// generated during chat. Keep `status.notice` empty for existing callers.
async function resolveAccessStatus(ctx, options = {}) {
  // Owner/admin identity is an application role, not a customer entitlement.
  // Resolve it before touching trial state or the backend so an expired local
  // trial, missing entitlement, or transient downgrade can never demote the
  // configured owner into a customer upgrade flow.
  if (isOwner(ctx)) {
    return {
      plan: 'owner',
      state: 'owner',
      allowedModes: [...OWNER_ALLOWED_MODES],
      canChat: true,
      planExpiresAt: null,
      trialExpiresAt: null,
      backendVerified: false,
      notice: null,
    };
  }
  ensureUser(ctx.from.id);
  return resolveEntitlementStatus(ctx.from.id, options);
}

async function gateChat(ctx) {
  const status = await resolveAccessStatus(ctx);
  if (!status.canChat) {
    await ctx.reply(TRIAL_EXPIRED_MESSAGE, planKeyboard());
    return null;
  }
  status.notice = null;
  const mode = getMode(ctx.from.id);
  if (mode !== 'text' && !status.allowedModes.includes(mode)) {
    setMode(ctx.from.id, 'text');
  }
  return status;
}

module.exports = {
  gateChat,
  resolveAccessStatus,
  OWNER_ALLOWED_MODES,
  TRIAL_EXPIRED_MESSAGE,
};
