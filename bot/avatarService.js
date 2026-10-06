// ─────────────────────────────────────────────────────────────────────────────
// Avatar reply orchestration for Eli's avatar mode ("Говори с аватара на Ели").
//
// This is the single choke point for every paid HeyGen generation:
//   text reply → credit check → capped text → HeyGen video → Telegram video.
//
// Normal mode ("Говори с Ели") never reaches this module. If anything here
// fails, the caller has ALREADY sent Eli's text reply, so the conversation
// never breaks — the user just gets text instead of video.
// ─────────────────────────────────────────────────────────────────────────────

const { isHeyGenConfigured } = require('./heygenConfig');
const { requestAvatarVideo, waitForVideoResult, capForAvatar } = require('./heygenService');
const { isApprovedLookId } = require('./avatarLooks');
const { checkFeatureCredits } = require('./credits');
const { meterAvatar } = require('./avatarMeteringClient');
const { isOwner } = require('./adminGuard');
const { createAvatarTrace } = require('./avatarDiagnostics');

// Plan verification remains independent of the durable backend quota check.
function checkAvatarCredits(userId) {
  return checkFeatureCredits(userId, 'avatar');
}

// Process-local optimization only; the Supabase reservation is authoritative.
const inFlight = new Set();

// Static waiting notice shown only when a real avatar generation is starting.
const WAITING_MESSAGE = '🎬 Ели подготвя видео отговора си… Моля, изчакай малко. ✨';
const AVATAR_HOLD_SECONDS = 30;

// Sends Eli's reply as a HeyGen avatar video to the same chat.
// Returns true when a video was sent; false when it fell back (caller's text
// reply remains the answer). Never throws.
async function sendAvatarReply(ctx, replyText, opts = {}) {
  const trace = createAvatarTrace();
  try {
  if (!isHeyGenConfigured()) {
    console.error('Avatar mode requested but HeyGen is not configured.');
    return false;
  }

  const userId = String(ctx.from.id);
  trace.stage = 'local_concurrency';
  if (inFlight.has(userId)) {
    console.warn(`Avatar video skipped [user ${userId}]: generation already in flight`);
    return false;
  }

  const updateId = ctx.update?.update_id;
  trace.stage = 'update_identity';
  if (!Number.isSafeInteger(updateId) || updateId <= 0 ||
      !/^[1-9]\d{4,18}$/.test(userId)) {
    console.warn('Avatar video blocked: stable Telegram update ID unavailable');
    return false;
  }
  const text = capForAvatar(replyText);
  trace.stage = 'script';
  if (!text) return false;

  // Context-aware Look: accept ONLY allowlisted Look IDs (server-side map in
  // avatarLooks.js). Anything else → undefined → configured default avatar.
  const lookId = isApprovedLookId(opts.lookId) ? opts.lookId : undefined;
  const requestId = `tg:${userId}:${updateId}`;
  inFlight.add(userId);
  try {
    // Drain an accepted, durable provider job before admitting another paid
    // generation. A crash or Telegram update loss must not strand accounting.
    trace.stage = 'pending_reservation';
    const outstanding = await meterAvatar('pending', userId, requestId);
    if (outstanding.status === 'submitting' || outstanding.status === 'uncertain') {
      opts.onPending?.();
      return false;
    }
    const activeRequestId = outstanding.status === 'submitted' ? outstanding.request_id : requestId;
    if (outstanding.status === 'submitted' &&
        (typeof activeRequestId !== 'string' || !/^tg:[1-9]\d{4,18}:[1-9]\d{0,18}$/.test(activeRequestId) ||
         !activeRequestId.startsWith(`tg:${userId}:`))) return false;
    // Owner is an application role from the trusted Telegram sender, not a
    // customer plan. Keep Voice/shared credit checks untouched.
    // Existing submitted jobs still reconcile even after entitlement expiry.
    trace.stage = 'authorization';
    const credits = isOwner(ctx) ? { allowed: true } : await checkAvatarCredits(ctx.from.id);
    if (!credits.allowed && outstanding.status !== 'submitted') {
      console.warn(`Avatar video blocked [user ${userId}]: ${credits.reason || 'not allowed'}`);
      return false;
    }
    // HeyGen text-to-video has no known pre-generation duration bound. Reserve
    // exactly 30 available seconds in the backend BEFORE any paid generation.
    let reservation;
    try {
      if (outstanding.status === 'submitted') {
        reservation = outstanding;
      } else {
        trace.stage = 'allowance';
        const allowance = await meterAvatar('allowance', userId, requestId);
        if (['settled', 'failed', 'submitting', 'uncertain'].includes(allowance.status)) return false;
        if (allowance.status === 'exhausted') { trace.reason = 'total_quota_exhausted'; opts.onQuotaExceeded?.(); return false; }
        if (allowance.status !== 'eligible' && allowance.status !== 'reserved') return false;
        if ((allowance.status === 'eligible' && allowance.available_seconds < AVATAR_HOLD_SECONDS) ||
            (allowance.status === 'reserved' && allowance.hold_seconds !== AVATAR_HOLD_SECONDS)) {
          opts.onInsufficientTime?.();
          trace.reason = 'insufficient_available_seconds';
          return false;
        }
        trace.stage = 'reserve';
        reservation = await meterAvatar('reserve', userId, requestId);
        if (reservation.status === 'reserved' && reservation.hold_seconds !== AVATAR_HOLD_SECONDS) return false;
      }
    } catch (error) {
      if (error?.code === 'avatar_quota_exceeded') opts.onQuotaExceeded?.();
      if (error?.code === 'avatar_pending_reconciliation') opts.onPending?.();
      throw error;
    }
    if (reservation.status === 'settled' || reservation.status === 'failed' ||
        reservation.status === 'submitting' || reservation.status === 'uncertain') return false;
    let videoId = reservation.video_id;
    if (reservation.status === 'reserved') {
      trace.stage = 'claim';
      const begun = await meterAvatar('begin', userId, activeRequestId);
      if (begun.status !== 'submitting') return false;
      try {
        trace.stage = 'heygen_submit';
        videoId = await requestAvatarVideo(text, lookId);
      } catch (error) {
        trace.error = error;
        // A provider HTTP rejection is conclusive; network failures, timeout,
        // or a successful POST with a missing job ID are NOT safe to retry.
        const definite = /^HeyGen generate: HTTP (400|401|402|403|404|422|429)$/.test(String(error?.message || ''));
        const httpStatus = /^HeyGen generate: HTTP (\d{3})$/.exec(String(error?.message || ''))?.[1];
        console.warn('Avatar submission outcome', {
          httpStatus: httpStatus ? Number(httpStatus) : undefined,
          state: definite ? 'failed' : 'uncertain',
        });
        try { await meterAvatar(definite ? 'failed' : 'uncertain', userId, activeRequestId); } catch (_) {}
        return false;
      }
      let saved;
      trace.stage = 'persist_video_id';
      try {
        saved = await meterAvatar('job', userId, activeRequestId, { video_id: videoId });
      } catch (_) {
        // A successful provider POST may outlive a backend timeout. We know
        // its job ID, so retry ONLY the idempotent storage transition.
        try { saved = await meterAvatar('job', userId, activeRequestId, { video_id: videoId }); }
        catch (_) {
          try { saved = await meterAvatar('get', userId, activeRequestId); }
          catch (error) { trace.error = error; return false; }
        }
      }
      if (saved.status !== 'submitted' || saved.video_id !== videoId) return false;
    }
    trace.stage = 'video_identity';
    if (typeof videoId !== 'string' || !videoId) return false;
    // The provider job is durably known and being polled — send ONE
    // static waiting message (no LLM, no HeyGen, no credits). Placed after
    // every gate so text/voice modes, blocked entitlements, in-flight locks
    // and duplicate updates never see it; placed inside the inFlight guard so
    // one request can never produce two of them. Best-effort: a Telegram
    // hiccup here must not cost the user their (paid) video.
    try {
      await ctx.reply(WAITING_MESSAGE);
    } catch (_) {
      /* waiting notice is best-effort */
    }
    trace.stage = 'telegram_action';
    await ctx.sendChatAction('record_video');
    let video;
    try {
      trace.stage = 'heygen_poll';
      video = await waitForVideoResult(videoId, {
      // Keep Telegram's "recording video" indicator alive while polling.
      onTick: async () => {
        try {
          await ctx.sendChatAction('upload_video');
        } catch (_) {
          /* indicator is best-effort */
        }
      },
      });
    } catch (error) {
      trace.error = error;
      // Only an explicit provider 'failed' status releases a reservation.
      if (String(error?.message || '') === 'HeyGen video failed: generation error') {
        try { await meterAvatar('failed', userId, activeRequestId); } catch (_) {}
      } else {
        opts.onPending?.();
      }
      return false;
    }
    // The text-to-video endpoint has no verified duration bound before its
    // paid POST. A video above 30 seconds therefore cannot be reconciled
    // automatically: retain the submitted hold for manual review, never debit
    // excess available seconds and never deliver an unaccounted paid video.
    trace.stage = 'duration_validation';
    if (!video || !Number.isInteger(video.durationSeconds) ||
        video.durationSeconds > reservation.hold_seconds) {
      opts.onPending?.();
      return false;
    }
    // Failed or ambiguous accounting MUST NOT deliver the paid video.
    let settled;
    try {
      trace.stage = 'settlement';
      settled = await meterAvatar('complete', userId, activeRequestId, {
        duration_seconds: video.durationSeconds, video_url: video.url,
      });
    } catch (error) {
      opts.onPending?.();
      throw error;
    }
    if (settled.status !== 'settled' ||
        settled.duration_seconds !== video.durationSeconds ||
        settled.video_url !== video.url) return false;
    trace.stage = 'delivery_authorization';
    if (!credits.allowed) return false;
    trace.stage = 'telegram_video';
    await ctx.replyWithVideo(
      { url: video.url },
      { caption: '💙 Ели' }
    );
    console.log(`Avatar video ok [user ${userId}]`);
    trace.delivered = true;
    return true;
  } catch (err) {
    trace.error = err;
    // Safe logging: HeyGen errors carry locally-built static messages; any
    // other error is reduced to its name so provider/Telegram payloads never
    // reach the logs.
    const msg = String(err?.message || '');
    const safe = msg.startsWith('HeyGen') ? msg : err?.name || 'error';
    console.error(`Avatar video failed [user ${userId}]: ${safe}`);
    // No user-facing message here: the caller sends the already-generated
    // text answer as the fallback (never a second AI response).
    return false;
  } finally {
    // Always release the lock — success, failure, or thrown error.
    inFlight.delete(userId);
  }
  } finally {
    trace.finish();
  }
}

module.exports = { sendAvatarReply, checkAvatarCredits, WAITING_MESSAGE };
