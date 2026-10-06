// ─────────────────────────────────────────────────────────────────────────────
// Voice reply orchestration for Eli's voice mode ("Говори с гласа на Ели").
//
// Mirrors avatarService.js: single choke point for every TTS voice reply:
//   text reply → credit check → capped text → TTS audio → Telegram voice note.
//
// The caller has ALREADY sent Eli's text reply before calling this, so any
// failure here degrades silently to text — the conversation never breaks.
//
// Provider: OpenAI TTS for now (no HeyGen credits are ever spent here). The
// provider lives only in synthesizeSpeech(), so swapping to another Bulgarian
// voice (e.g. HeyGen TTS) later touches exactly one function.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const openai = require('./openaiClient');
const { checkFeatureCredits } = require('./credits');

// Keep spoken replies short-ish: TTS cost and listener patience both scale
// with length. Cuts on a sentence boundary when possible.
const { stripLookTags } = require('./avatarLooks');

const VOICE_TEXT_LIMIT = 600;

const TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_VOICE = 'nova'; // warm female voice; handles Bulgarian text
const TTS_INSTRUCTIONS =
  'Говори на български, топло, спокойно и естествено — като грижовна приятелка.';

function capForVoice(text) {
  // Strip Markdown decoration (*bold*, _italic_, `code`, # headers, list
  // bullets) so the TTS voice never reads out formatting characters — some
  // deterministic answers (profile dumps, log summaries) use Markdown.
  // Internal [LOOK:...] service tags must never be spoken (defense in depth —
  // covers stored user data echoed through deterministic voice replies).
  const clean = stripLookTags(text || '')
    .replace(/[*_`#]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .trim();
  if (!clean) return '';
  if (clean.length <= VOICE_TEXT_LIMIT) return clean;
  const slice = clean.slice(0, VOICE_TEXT_LIMIT);
  const lastStop = Math.max(
    slice.lastIndexOf('.'),
    slice.lastIndexOf('!'),
    slice.lastIndexOf('?')
  );
  return lastStop > VOICE_TEXT_LIMIT * 0.5
    ? slice.slice(0, lastStop + 1)
    : slice;
}

// Convert an MP3 buffer to OGG/Opus — the format Telegram requires for real
// voice notes (round bubble with waveform). Same defensive ffmpeg pattern as
// voiceTranscription.js.
function mp3ToOpus(mp3Buffer) {
  const inPath = path.join(os.tmpdir(), `eli-tts-${crypto.randomUUID()}.mp3`);
  const outPath = path.join(os.tmpdir(), `eli-tts-${crypto.randomUUID()}.ogg`);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      for (const p of [inPath, outPath]) {
        fs.unlink(p, () => {});
      }
    };
    fs.writeFile(inPath, mp3Buffer, (writeErr) => {
      if (writeErr) {
        cleanup();
        return reject(writeErr);
      }
      const ff = spawn(
        'ffmpeg',
        ['-y', '-i', inPath, '-c:a', 'libopus', '-b:a', '48k', '-ac', '1', outPath],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ff.kill('SIGKILL');
        cleanup();
        reject(new Error('ffmpeg opus conversion timed out'));
      }, 30000);
      ff.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      ff.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error(`ffmpeg spawn failed: ${err.message}`));
      });
      ff.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          cleanup();
          return reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`));
        }
        fs.readFile(outPath, (readErr, data) => {
          cleanup();
          if (readErr) return reject(readErr);
          resolve(data);
        });
      });
    });
  });
}

// The ONLY place that talks to a TTS provider. Returns an MP3 buffer.
// Conversion to Opus is a separate local stage (audio-preparation) so network
// retries never re-run because of a local ffmpeg fault, and diagnostics can
// tell the two stages apart.
async function synthesizeSpeech(text) {
  if (!openai) throw new Error('OpenAI not configured');
  const response = await openai.audio.speech.create({
    model: TTS_MODEL,
    voice: TTS_VOICE,
    input: text,
    instructions: TTS_INSTRUCTIONS,
    response_format: 'mp3',
  });
  return Buffer.from(await response.arrayBuffer());
}

// Retry a stage once after a transient failure (network error, timeout,
// HTTP 429/5xx). Honors Telegram's retry_after hint when present. Permanent
// errors (4xx other than 429) are not retried.
async function withOneRetry(fn, stage) {
  try {
    return await fn();
  } catch (err) {
    const status = err?.status || err?.response?.error_code;
    const transient =
      status === undefined || status === 429 || (status >= 500 && status < 600);
    if (!transient) throw err;
    const retryAfterSec = err?.response?.parameters?.retry_after;
    const delayMs = Math.min((retryAfterSec ? retryAfterSec * 1000 : 1500), 10000);
    console.warn(`Voice reply: transient ${stage} failure (${status ?? err?.name ?? 'network'}), retrying once in ${delayMs}ms`);
    await new Promise((r) => setTimeout(r, delayMs));
    return fn();
  }
}

// Sends Eli's reply as a Telegram voice note. Returns true when the voice
// note was sent; false when it fell back (the caller's text reply remains the
// answer). Never throws. Each stage is retried once on transient failures and
// logged with a safe stage label, so a real-world failure is diagnosable from
// the console without exposing provider payloads or secrets.
async function sendVoiceReply(ctx, replyText) {
  const startedAt = Date.now();
  const userId = ctx?.from?.id ?? 'unknown';
  try {
    // Server-side entitlement + quota gate — the REAL guard before any paid
    // TTS work. Returning false makes the caller fall back to the text answer.
    const credits = await checkFeatureCredits(ctx.from.id, 'voice');
    if (!credits.allowed) {
      console.warn(`Voice reply blocked [user ${userId}]: ${credits.reason || 'not allowed'}`);
      return false;
    }

    const text = capForVoice(replyText);
    if (!text) {
      console.warn(`Voice out skipped [user ${userId}]: empty text after capping`);
      return false;
    }

    try {
      await ctx.sendChatAction('record_voice');
    } catch (_) {
      /* indicator is best-effort — never blocks the voice reply */
    }

    let mp3;
    try {
      mp3 = await withOneRetry(() => synthesizeSpeech(text), 'tts-synthesis');
    } catch (err) {
      // Stage label only — provider error messages can echo response details,
      // so they are never logged. The text reply was already sent.
      console.error(
        `Voice reply failed at stage: tts-synthesis (${err?.status || err?.name || 'error'}) [user ${userId}]`
      );
      return false;
    }
    let opus;
    try {
      opus = await mp3ToOpus(mp3);
    } catch (err) {
      // Local ffmpeg/temp-file fault — never retried against the TTS API.
      console.error(
        `Voice reply failed at stage: audio-preparation (${err?.name || 'error'}) [user ${userId}]`
      );
      return false;
    }
    if (!opus || opus.length === 0) {
      console.error(`Voice reply failed at stage: audio-preparation (empty buffer) [user ${userId}]`);
      return false;
    }
    try {
      // Note: a retry after an ambiguous network failure could — rarely —
      // deliver two voice notes if Telegram accepted the first upload but the
      // response was lost. That tradeoff is deliberate: a duplicate note is
      // better than a silent miss. The warn log below marks the ambiguity.
      await withOneRetry(
        () => ctx.replyWithVoice({ source: opus, filename: 'eli.ogg' }),
        'telegram-delivery'
      );
    } catch (err) {
      console.error(
        `Voice reply failed at stage: telegram-delivery (${err?.response?.error_code || err?.name || 'error'}) [user ${userId}]`
      );
      return false;
    }
    console.log(
      `Voice out ok [user ${userId}]: ${opus.length} bytes in ${Date.now() - startedAt}ms`
    );
    return true;
  } catch (err) {
    // Anything outside the stages above (credit gate, unexpected errors).
    console.error(`Voice reply failed at stage: pre-delivery (details withheld) [user ${userId}]`);
    return false;
  }
}

module.exports = { sendVoiceReply, capForVoice, VOICE_TEXT_LIMIT };
