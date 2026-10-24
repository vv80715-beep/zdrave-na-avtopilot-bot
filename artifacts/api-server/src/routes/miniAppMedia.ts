import Busboy from "busboy";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import type { Request, RequestHandler, Response, Router } from "express";
import {
  type MediaAiProcessor,
  type MediaLanguage,
} from "../lib/miniAppMediaAi.ts";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 90;
const MAX_MULTIPART_OVERHEAD = 32 * 1024;
const UPLOAD_TIMEOUT_MS = 60_000;

type MediaKind = "image" | "voice";
export type MiniAppMediaRouteOptions = {
  processor?: MediaAiProcessor;
  voiceTurnEnabled?: boolean;
  processVoiceTurn?: (input: {
    userId: string;
    audio: Buffer;
    mode: "text" | "voice" | "avatar";
    turnId: string;
    prompt: string;
  }) => Promise<Record<string, unknown>>;
  tempRoot?: string;
  inspectAudioDuration?: (filePath: string) => Promise<number>;
  normalizeAudio?: (filePath: string, directory: string) => Promise<string>;
  now?: () => number;
};

type ReceivedUpload = {
  path: string;
  directory: string;
  mimeType: string;
  language: MediaLanguage;
  caption: string;
  mode: "text" | "voice" | "avatar";
  turnId: string;
  prompt: string;
};

class MediaRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function fail(status: number, code: string): never {
  throw new MediaRequestError(status, code);
}

function sendMediaError(res: Response, status: number, code: string) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ error: code });
}

function languageValue(value: string | undefined): MediaLanguage {
  if (value === undefined || value === "bg") return "bg";
  if (value === "en") return "en";
  fail(400, "invalid_language");
}

function createFixedMockProcessor(): MediaAiProcessor {
  return {
    async analyzeImage({ language }) {
      return {
        reply: language === "en"
          ? "Fixed staging mock: the image was received, but not analyzed."
          : "Фиксиран staging mock: снимката е приета, но не е анализирана.",
      };
    },
    async transcribeAndAnswer({ language }) {
      return language === "en"
        ? {
            transcript: "[MOCK transcript — audio was not transcribed]",
            reply: "Fixed staging mock: the audio was received, but not analyzed.",
          }
        : {
            transcript: "[МОК транскрипт — аудиото не е транскрибирано]",
            reply: "Фиксиран staging mock: аудиото е прието, но не е анализирано.",
          };
    },
  };
}

function matchesImageSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === "image/webp") {
    return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP";
  }
  return false;
}

function matchesAudioSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "audio/ogg") return bytes.subarray(0, 4).toString("ascii") === "OggS";
  if (mimeType === "audio/webm") return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mimeType === "audio/mp4") return bytes.length >= 8 && bytes.toString("ascii", 4, 8) === "ftyp";
  if (mimeType === "audio/wav") return bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
  return false;
}

async function validateSignature(pathname: string, kind: MediaKind, mimeType: string) {
  const handle = await open(pathname, "r");
  try {
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const header = bytes.subarray(0, bytesRead);
    const valid = kind === "image"
      ? matchesImageSignature(header, mimeType)
      : matchesAudioSignature(header, mimeType);
    if (!valid) fail(415, "file_type_or_signature_mismatch");
  } finally {
    await handle.close();
  }
}

async function receiveUpload(
  req: Request,
  kind: MediaKind,
  tempRoot: string,
): Promise<ReceivedUpload> {
  const maxBytes = kind === "image" ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
  if (!req.is("multipart/form-data")) fail(415, "multipart_required");
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes + MAX_MULTIPART_OVERHEAD) {
    fail(413, "file_too_large");
  }

  const directory = await mkdtemp(path.join(tempRoot, "eli-mini-media-"));
  const filePath = path.join(directory, "upload");
  try {
    const received = await new Promise<ReceivedUpload>((resolve, reject) => {
      let fileCount = 0;
      let fileMimeType = "";
      let language: MediaLanguage = "bg";
      let caption = "";
      let mode: ReceivedUpload["mode"] = "text";
      let turnId = "";
      let prompt = "";
      let languageSeen = false;
      let captionSeen = false;
      let modeSeen = false;
      let turnIdSeen = false;
      let promptSeen = false;
      let fileSize = 0;
      let failure: MediaRequestError | null = null;
      let settled = false;
      const fileWrites: Promise<void>[] = [];
      const parser = Busboy({
        headers: req.headers,
        limits: {
          fileSize: maxBytes,
          files: 1,
          fields: 5,
          parts: 6,
          fieldNameSize: 32,
          fieldSize: 1200,
        },
      });
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      parser.on("file", (fieldName, stream, info) => {
        fileCount += 1;
        fileMimeType = info.mimeType.toLowerCase();
        if (fieldName !== "file" || fileCount > 1) {
          failure = new MediaRequestError(400, "one_file_required");
          stream.resume();
          return;
        }
        if (kind === "image" && !["image/jpeg", "image/png", "image/webp"].includes(fileMimeType)) {
          failure = new MediaRequestError(415, "unsupported_image_type");
          stream.resume();
          return;
        }
        if (kind === "voice" && !["audio/ogg", "audio/webm", "audio/mp4", "audio/wav"].includes(fileMimeType)) {
          failure = new MediaRequestError(415, "unsupported_audio_type");
          stream.resume();
          return;
        }
        stream.on("data", (chunk: Buffer) => {
          fileSize += chunk.length;
        });
        stream.on("limit", () => {
          failure = new MediaRequestError(413, "file_too_large");
        });
        fileWrites.push(pipeline(stream, createWriteStream(filePath, { flags: "wx", mode: 0o600 }))
          .catch(() => {
            failure = new MediaRequestError(400, "upload_failed");
          }));
      });

      parser.on("field", (name, value, info) => {
        if (info.valueTruncated || info.nameTruncated) {
          failure = new MediaRequestError(413, "field_too_large");
          return;
        }
        if (name === "language" && !languageSeen) {
          languageSeen = true;
          try {
            language = languageValue(value);
          } catch {
            failure = new MediaRequestError(400, "invalid_language");
          }
        } else if (name === "caption" && !captionSeen && kind === "image") {
          captionSeen = true;
          caption = value.trim();
        } else if (name === "mode" && !modeSeen && kind === "voice" &&
            ["text", "voice", "avatar"].includes(value)) {
          modeSeen = true;
          mode = value as ReceivedUpload["mode"];
        } else if (name === "turnId" && !turnIdSeen && kind === "voice" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
          turnIdSeen = true;
          turnId = value;
        } else if (name === "prompt" && !promptSeen && kind === "voice") {
          promptSeen = true;
          prompt = value.trim();
        } else {
          failure = new MediaRequestError(400, "unexpected_field");
        }
      });
      parser.on("filesLimit", () => { failure = new MediaRequestError(400, "one_file_required"); });
      parser.on("fieldsLimit", () => { failure = new MediaRequestError(400, "too_many_fields"); });
      parser.on("partsLimit", () => { failure = new MediaRequestError(400, "too_many_parts"); });
      parser.on("error", () => rejectOnce(new MediaRequestError(400, "invalid_multipart")));
      parser.on("finish", () => {
        void (async () => {
          await Promise.all(fileWrites);
          if (settled) return;
          if (failure) {
            rejectOnce(failure);
            return;
          }
          if (fileCount !== 1 || fileSize === 0) {
            rejectOnce(new MediaRequestError(400, "one_file_required"));
            return;
          }
          settled = true;
          resolve({ path: filePath, directory, mimeType: fileMimeType, language, caption, mode, turnId, prompt });
        })().catch(() => rejectOnce(new MediaRequestError(400, "upload_failed")));
      });

      req.setTimeout(UPLOAD_TIMEOUT_MS, () => {
        parser.destroy(new Error("upload_timeout"));
      });
      req.pipe(parser);
    });

    await validateSignature(received.path, kind, received.mimeType);
    const details = await stat(received.path);
    if (details.size > maxBytes) fail(413, "file_too_large");
    return received;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function probeAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const process = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      process.kill("SIGKILL");
      reject(new MediaRequestError(415, "invalid_audio"));
    }, 10_000);
    process.stdout.on("data", (chunk: Buffer) => {
      if (output.length < 128) output += chunk.toString("utf8").slice(0, 128 - output.length);
    });
    process.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new MediaRequestError(415, "invalid_audio"));
    });
    process.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const seconds = Number(output.trim());
      if (code !== 0 || !Number.isFinite(seconds) || seconds <= 0) {
        reject(new MediaRequestError(415, "invalid_audio"));
        return;
      }
      resolve(seconds);
    });
  });
}

async function normalizeAudioToWav(filePath: string, directory: string): Promise<string> {
  const outputPath = path.join(directory, "normalized.wav");
  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-nostdin", "-y", "-i", filePath,
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      "-t", String(MAX_AUDIO_SECONDS + 1),
      outputPath,
    ], { stdio: ["ignore", "ignore", "ignore"] });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ffmpeg.kill("SIGKILL");
      reject(new MediaRequestError(415, "invalid_audio"));
    }, 30_000);
    ffmpeg.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new MediaRequestError(415, "invalid_audio"));
    });
    ffmpeg.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new MediaRequestError(415, "invalid_audio"));
    });
  });
  return outputPath;
}

function makeLimiter(now: () => number) {
  const recent: number[] = [];
  let active = false;
  return {
    acquire(): boolean {
      const current = now();
      while (recent.length && current - recent[0] >= 60_000) recent.shift();
      if (active || recent.length >= 3) return false;
      active = true;
      recent.push(current);
      return true;
    },
    release() {
      active = false;
    },
  };
}

export function registerMiniAppMediaRoutes(
  router: Router,
  requireOwnerSession: RequestHandler,
  enabled: boolean,
  env: NodeJS.ProcessEnv,
  options: MiniAppMediaRouteOptions = {},
) {
  const voiceTurnEnabled = options.voiceTurnEnabled === true;
  if (!enabled && !voiceTurnEnabled) return;
  const processor = options.processor ?? createFixedMockProcessor();
  const inspectDuration = options.inspectAudioDuration ?? probeAudioDuration;
  const normalizeAudio = options.normalizeAudio ?? normalizeAudioToWav;
  const limiters = new Map<string, { limiter: ReturnType<typeof makeLimiter>; touched: number }>();
  const now = options.now ?? Date.now;
  function userLimiter(userId: string) {
    const current = now();
    for (const [id, value] of limiters) {
      if (current - value.touched > 600_000) limiters.delete(id);
    }
    let value = limiters.get(userId);
    if (!value) {
      if (limiters.size >= 1000) return null;
      value = { limiter: makeLimiter(now), touched: current };
      limiters.set(userId, value);
    }
    value.touched = current;
    return value.limiter;
  }
  const tempRoot = options.tempRoot ?? os.tmpdir();

  const handle = (kind: MediaKind): RequestHandler => async (req, res): Promise<void> => {
    const processVoiceTurn = options.processVoiceTurn;
    const liveVoiceTurn = kind === "voice" && voiceTurnEnabled && typeof processVoiceTurn === "function";
    if (!processor && !liveVoiceTurn) {
      sendMediaError(res, 503, "media_ai_unavailable");
      return;
    }
    const limiter = userLimiter(String(res.locals.miniAppUserId));
    if (!limiter?.acquire()) {
      sendMediaError(res, 429, "media_request_limited");
      return;
    }
    let upload: ReceivedUpload | undefined;
    let responseBody: Record<string, unknown> | null = null;
    let responseStatus = 200;
    try {
      if (kind === "image" && !enabled) {
        sendMediaError(res, 404, "not_found");
        return;
      }
      upload = await receiveUpload(req, kind, tempRoot);
      req.setTimeout(0);
      if (liveVoiceTurn && !upload.turnId) fail(400, "turn_id_required");
      if (kind === "image") {
        const result = await processor.analyzeImage({
          path: upload.path,
          mimeType: upload.mimeType,
          caption: upload.caption,
          language: upload.language,
        });
        responseBody = { reply: result.reply, mediaType: "image", staged: true, demo: true };
      } else {
        // Browser MediaRecorder WebM/MP4 often has no container duration.
        // Decode to bounded PCM first, then measure actual samples.
        const normalizedPath = await normalizeAudio(upload.path, upload.directory);
        const duration = await inspectDuration(normalizedPath);
        if (!Number.isFinite(duration) || duration <= 0) fail(415, "invalid_audio");
        if (duration > MAX_AUDIO_SECONDS) {
          responseStatus = 413;
          responseBody = { error: "audio_too_long" };
        } else {
          if (liveVoiceTurn) {
            const userId = res.locals.miniAppUserId;
            if (typeof userId !== "string") fail(401, "telegram_auth_required");
            const audio = await readFile(normalizedPath);
            if (audio.length > 4 * 1024 * 1024) fail(413, "normalized_audio_too_large");
            const result = await processVoiceTurn({
              userId,
              audio,
              mode: upload.mode,
              turnId: upload.turnId,
              prompt: upload.prompt,
            });
            responseBody = { ...result, mediaType: "voice", staged: false, demo: false };
          } else {
            const result = await processor!.transcribeAndAnswer({
              path: normalizedPath,
              mimeType: "audio/wav",
              language: upload.language,
            });
            responseBody = {
              transcript: result.transcript,
              reply: result.reply,
              mediaType: "voice",
              staged: true,
              demo: true,
            };
          }
        }
      }
    } catch (error) {
      if (error instanceof MediaRequestError) {
        responseStatus = error.status;
        responseBody = { error: error.code };
      } else {
        req.log?.error({ mediaType: kind }, "Mini App media processing failed");
        responseStatus = 502;
        responseBody = { error: "media_processing_failed" };
      }
    } finally {
      try {
        if (upload) await rm(upload.directory, { recursive: true, force: true });
      } finally {
        limiter.release();
      }
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(responseStatus).json(responseBody ?? { error: "media_processing_failed" });
  };

  if (enabled) router.post("/media/image", requireOwnerSession, handle("image"));
  if (enabled || voiceTurnEnabled) router.post("/media/voice", requireOwnerSession, handle("voice"));
}
