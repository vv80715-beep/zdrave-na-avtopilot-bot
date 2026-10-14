// ─────────────────────────────────────────────────────────────────────────────
// HeyGen API client — the ONLY module that talks to the HeyGen API.
//
// Isolation rules:
// - Credentials come exclusively from ./heygenConfig (Replit Secrets).
// - Secrets and IDs are NEVER logged and never appear in user-facing messages.
// - Nothing here runs automatically; a paid generation happens only when
//   generateAvatarVideo() is explicitly called (avatar mode only).
//
// Bulgarian: HeyGen voices speak the text they are given. Eli's replies are
// Bulgarian, so the chosen HEYGEN_VOICE_ID must be a Bulgarian-capable voice —
// the text is passed through verbatim (UTF-8 / Cyrillic-safe JSON).
// ─────────────────────────────────────────────────────────────────────────────

const { getHeyGenConfig } = require('./heygenConfig');
const { stripLookTags } = require('./avatarLooks');
const { providerReason } = require('./avatarDiagnostics');

const HEYGEN_BASE = 'https://api.heygen.com';

// Avatar-only script limits. Keep complete Bulgarian sentences; if an
// over-limit answer has no safe sentence boundary, skip video rather than
// submitting an ugly or semantically incomplete fragment.
const MAX_AVATAR_TEXT_CHARS = 180;
const MAX_AVATAR_WORDS = 22;

function countWords(text) {
  return (String(text || '').match(/\S+/gu) || []).length;
}

function capForAvatar(text, maxChars = MAX_AVATAR_TEXT_CHARS, maxWords = MAX_AVATAR_WORDS) {
  const normalized = stripLookTags(text || '').replace(/\s+/gu, ' ').trim();
  if (!normalized) return '';
  const fits = (value) => value.length <= maxChars && countWords(value) <= maxWords;

  // Preserve a complete short reply exactly, apart from whitespace/tag cleanup.
  if (fits(normalized)) return normalized;

  // Split only after terminal punctuation followed by whitespace. This avoids
  // treating decimal numbers or abbreviations as sentence boundaries.
  const sentences = normalized.split(/(?<=[.!?])\s+/u);
  let result = '';
  for (const sentence of sentences) {
    if (!/[.!?]$/u.test(sentence)) break;
    const candidate = result ? `${result} ${sentence}` : sentence;
    if (!fits(candidate)) break;
    result = candidate;
  }
  return result;
}

// Per-request hard deadline so a hung connection can never stall the polling
// loop past its overall timeout.
const REQUEST_TIMEOUT_MS = 20000;

// `label` is a LOCAL, static description ("generate", "status") used in error
// messages instead of URLs, paths, or provider-supplied text — provider error
// bodies may echo configured IDs and must never reach logs.
async function heygenFetch(path, label, options = {}) {
  const { apiKey } = getHeyGenConfig();
  let res;
  try {
    res = await fetch(`${HEYGEN_BASE}${path}`, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs || REQUEST_TIMEOUT_MS),
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    const kind = err?.name === 'TimeoutError' ? 'request timeout' : 'network error';
    throw new Error(`HeyGen ${label}: ${kind}`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    /* non-JSON error body */
  }
  if (!res.ok) {
    // Status code only — never the provider's message, which may echo IDs.
    const error = new Error(`HeyGen ${label}: HTTP ${res.status}`);
    error.avatarReason = providerReason(res.status, body);
    throw error;
  }
  return body;
}

// Starts a video generation job. PAID CALL — avatar mode only.
// Returns the HeyGen video_id.
async function requestAvatarVideo(text, lookId) {
  const { avatarId, voiceId } = getHeyGenConfig();
  const body = {
    video_inputs: [
      {
        character: {
          type: 'avatar',
          // Context-aware Look (validated allowlist ID) or the configured
          // default avatar. Never a caller/user-supplied arbitrary value —
          // avatarService re-validates lookId against the allowlist.
          avatar_id: lookId || avatarId,
          avatar_style: 'normal',
        },
        voice: {
          type: 'text',
          input_text: text, // Bulgarian text passed through verbatim
          voice_id: voiceId,
        },
      },
    ],
    // Modest dimensions keep generation faster and cheaper; Telegram videos
    // don't need more.
    dimension: { width: 1280, height: 720 },
  };
  const data = await heygenFetch('/v2/video/generate', 'generate', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const videoId = data?.data?.video_id;
  if (!videoId) throw new Error('HeyGen did not return a video_id.');
  return videoId;
}

// Poll the original V1 status endpoint for the actual rendered-video duration.
async function waitForVideoResult(videoId, { timeoutMs = 240000, intervalMs = 5000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let data;
    try {
      data = await heygenFetch(`/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, 'status');
    } catch (err) {
      // Transient status-poll failures (timeout/network/5xx) shouldn't kill an
      // in-flight generation — keep polling until the overall deadline.
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    const status = data?.data?.status;
    if (status === 'completed') {
      const url = data?.data?.video_url;
      if (!url) throw new Error('HeyGen video completed but no video_url returned.');
      const duration = Number(data?.data?.duration ?? data?.data?.video_duration);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 600) {
        throw new Error('HeyGen video completed but duration unavailable');
      }
      return { url, durationSeconds: Math.ceil(duration) };
    }
    if (status === 'failed') {
      // Local, static message only — provider error text may echo IDs.
      throw new Error('HeyGen video failed: generation error');
    }
    if (typeof onTick === 'function') {
      try {
        await onTick(status);
      } catch (_) {
        /* keep polling even if the tick callback fails */
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('HeyGen video generation timed out.');
}

async function waitForVideo(videoId, opts = {}) {
  return (await waitForVideoResult(videoId, opts)).url;
}

// Full flow: request → poll → URL. PAID CALL — avatar mode only.
async function generateAvatarVideo(text, opts = {}) {
  const videoId = await requestAvatarVideo(text, opts.lookId);
  return waitForVideo(videoId, opts);
}

module.exports = {
  generateAvatarVideo,
  requestAvatarVideo,
  waitForVideo,
  waitForVideoResult,
  capForAvatar,
  MAX_AVATAR_TEXT_CHARS,
  MAX_AVATAR_WORDS,
};
