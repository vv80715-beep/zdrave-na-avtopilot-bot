const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const openai = require('./openaiClient');

// Speech-to-text model + forced language. gpt-4o-transcribe handles Bulgarian
// well and accepts the ISO-639-1 `language` hint, which prevents the model from
// guessing the wrong language and returning Latin/garbled output.
const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
const TRANSCRIBE_LANGUAGE = 'bg';

// OpenAI accepts: flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm.
const MIME_SUFFIX = {
  'audio/ogg': '.ogg',
  'audio/opus': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.m4a',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/webm': '.webm',
  'audio/flac': '.flac',
};

// Pick a sensible file extension for an `audio` message (used only for the
// downloaded source file before conversion).
function audioSuffix(audio) {
  if (audio?.file_name && audio.file_name.includes('.')) {
    return audio.file_name.slice(audio.file_name.lastIndexOf('.')).toLowerCase();
  }
  return MIME_SUFFIX[audio?.mime_type] || '.ogg';
}

// Heuristic sanity check: a real Bulgarian transcript is predominantly
// Cyrillic. Empty text or mostly-Latin output means we couldn't understand it.
function looksLikeBulgarian(text) {
  const clean = (text || '').trim();
  if (!clean) return false;
  const letters = (clean.match(/\p{L}/gu) || []).length;
  if (letters === 0) return false;
  const cyrillic = (clean.match(/[\u0400-\u04FF]/g) || []).length;
  return cyrillic / letters >= 0.5;
}

async function downloadToTemp(ctx, fileId, suffix) {
  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(link);
  if (!res.ok) {
    throw new Error(`Audio download failed: HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const tmpPath = path.join(
    os.tmpdir(),
    `tg-audio-${crypto.randomUUID()}${suffix}`
  );
  await fs.promises.writeFile(tmpPath, buffer);
  return tmpPath;
}

// Convert any input (Telegram voice is OGG/Opus) to 16 kHz mono PCM WAV — the
// most reliable, STT-friendly format for OpenAI transcription.
function convertToWav(inputPath) {
  const outputPath = path.join(
    os.tmpdir(),
    `tg-audio-${crypto.randomUUID()}.wav`
  );
  return new Promise((resolve, reject) => {
    const ff = spawn(
      'ffmpeg',
      ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderr = '';
    let settled = false;
    // Defensive: kill a hung ffmpeg so a voice request never stalls forever.
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ff.kill('SIGKILL');
        reject(new Error('ffmpeg conversion timed out'));
      }
    }, 30000);
    ff.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    ff.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });
    ff.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`));
    });
  });
}

// Download a Telegram audio/voice file, convert it to WAV, transcribe it in
// Bulgarian, and always remove temp files afterwards. Throws only on real
// download/convert/API failures; an empty/garbled transcript returns text the
// caller can sanity-check with looksLikeBulgarian().
async function transcribeTelegramAudio(ctx, fileId, suffix = '.ogg') {
  if (!openai) throw new Error('OpenAI not configured');

  let srcPath;
  let wavPath;
  try {
    srcPath = await downloadToTemp(ctx, fileId, suffix);
    wavPath = await convertToWav(srcPath);
    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: TRANSCRIBE_MODEL,
      language: TRANSCRIBE_LANGUAGE,
    });
    return (result?.text || '').trim();
  } finally {
    for (const p of [srcPath, wavPath]) {
      if (!p) continue;
      try {
        await fs.promises.unlink(p);
      } catch (err) {
        console.error('Failed to clean up temp audio file:', err.message);
      }
    }
  }
}

module.exports = {
  transcribeTelegramAudio,
  audioSuffix,
  looksLikeBulgarian,
  TRANSCRIBE_MODEL,
  TRANSCRIBE_LANGUAGE,
};
