import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { Router, type Application, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { validateTelegramInitData } from "../lib/telegramInitData.mjs";
// @ts-expect-error The CommonJS persona module is the canonical prompt shared with the Telegram bot.
import eliPersona from "../../../../bot/persona.js";
// @ts-expect-error The selector rechecks the owner and filters dossier facts by message topic.
import ownerDossier from "../../../../bot/ownerDossier.js";
import {
  registerMiniAppMediaRoutes,
  type MiniAppMediaRouteOptions,
} from "./miniAppMedia.ts";

const COOKIE = "eli_mini_owner_session";
const SESSION_TTL_SECONDS = 600;
const INIT_DATA_MAX_AGE_SECONDS = 300;
const COOKIE_PATH = "/api/mini-app";
const STATIC_REPLIES = {
  bg: "Това е фиксиран owner-only демо отговор. Не е изпратена AI заявка.",
  en: "This is a fixed owner-only demo reply. No AI request was made.",
};
const TEXT_AI_MODEL = "gpt-4o-mini";
const TEXT_AI_MAX_OUTPUT_TOKENS = 400;
const TEXT_AI_MAX_INPUT_CHARS = 1200;
const TEXT_AI_MINUTE_LIMIT = 5;
const TEXT_AI_DAILY_LIMIT = 20;
const TEXT_AI_TIMEOUT_MS = 25_000;
const OPENAI_KEY_FORMAT = /^sk-[A-Za-z0-9_-]{20,}$/;
const TEXT_AI_TEST_BOUNDARY = [
  "This is an isolated owner-only staging test, not the production Telegram conversation.",
  "You have no access to synchronized profile, private owner dossier, health logs, previous chat history, or saved memory.",
  "Never claim to remember or know personal facts that are not present in the current message.",
  "If asked about prior conversations or personal history, say this test has no synchronized memory.",
].join(" ");
const SYSTEM_PROMPT = (eliPersona as { SYSTEM_PROMPT: string }).SYSTEM_PROMPT;
type SessionClaims = { sub: string; iat: number; exp: number; nonce: string };

type Env = NodeJS.ProcessEnv;
type VerifiedInitData = ReturnType<typeof validateTelegramInitData>;
type MiniAppLanguage = "bg" | "en";
type TextAiAdapter = (input: {
  message: string;
  language: MiniAppLanguage;
  ownerDossierContext?: string;
}) => Promise<string>;

export function createOpenAiTextAiAdapter(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): TextAiAdapter {
  return async ({ message, language, ownerDossierContext }) => {
    const languageRule = language === "en"
      ? "Reply in English."
      : "Отговаряй на български.";
    const boundary = ownerDossierContext
      ? [
          "This is an isolated owner-only staging test, not the production Telegram conversation.",
          "Use only the topic-filtered private owner dossier context included in the system prompt.",
          "You have no access to profile stores, health logs, relationship-memory stores, prior Telegram turns, or Universal Memory.",
          "Never claim to remember prior conversation turns; the Mini App has no synchronized chat history.",
        ].join(" ")
      : TEXT_AI_TEST_BOUNDARY;
    const systemContext = ownerDossierContext
      ? `${ownerDossierContext}\n\n${SYSTEM_PROMPT}`
      : SYSTEM_PROMPT;
    const response = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TEXT_AI_MODEL,
        max_tokens: TEXT_AI_MAX_OUTPUT_TOKENS,
        messages: [
          {
            role: "system",
            content: `${systemContext}\n\n${boundary}\n${languageRule}`,
          },
          { role: "user", content: message },
        ],
      }),
      signal: AbortSignal.timeout(TEXT_AI_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) {
      if (response.status === 429) throw new Error("provider_rate_limited");
      throw new Error("provider_unavailable");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("provider_invalid_response");
    }
    const reply = (payload as {
      choices?: Array<{ message?: { content?: unknown } }>;
    })?.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || !reply.trim()) {
      throw new Error("provider_empty_response");
    }
    return reply.trim().slice(0, 6000);
  };
}

function isPublicHttpsOrigin(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      url.hostname.includes(".") &&
      url.hostname !== "localhost" &&
      url.hostname !== "example.org" &&
      !url.hostname.endsWith(".example.org") &&
      !url.hostname.endsWith(".localhost") &&
      !url.hostname.endsWith(".internal") &&
      !url.hostname.endsWith(".local") &&
      !url.hostname.endsWith(".test") &&
      !url.hostname.endsWith(".example") &&
      !url.hostname.endsWith(".invalid") &&
      !url.hostname.startsWith("[") &&
      !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname);
  } catch {
    return false;
  }
}

export function miniAppConfigEnabled(env: Env): boolean {
  return env.NODE_ENV === "development" &&
    env.ELI_MINI_APP_STAGE === "staging" &&
    env.ELI_MINI_APP_SESSION_ENABLED === "true" &&
    isPublicHttpsOrigin(env.ELI_MINI_APP_ORIGIN) &&
    /^[1-9]\d{4,19}$/.test(env.OWNER_TELEGRAM_ID || "") &&
    Boolean(env.TELEGRAM_BOT_TOKEN?.trim()) &&
    Boolean(env.SESSION_SECRET && env.SESSION_SECRET.trim().length >= 32);
}

function sendError(res: Response, status: number, code: string) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ error: code });
}

function signSession(payload: string, secret: string) {
  return createHmac("sha256", secret).update(`eli-mini-session-v1.${payload}`).digest("base64url");
}

function readCookie(req: Request): string | null {
  const cookieHeader = req.headers.cookie || "";
  for (const item of cookieHeader.split(";")) {
    const [name, ...rest] = item.trim().split("=");
    if (name === COOKIE) return rest.join("=") || null;
  }
  return null;
}

function readValidSession(
  req: Request,
  ownerId: string,
  sessionSecret: string,
  nowSeconds: number,
): { session: SessionClaims } | { error: "session_required" | "session_invalid" | "session_expired" } {
  const value = readCookie(req);
  const [payload, signature, extra] = value?.split(".") || [];
  if (!payload || !signature || extra) return { error: "session_required" };
  const expected = Buffer.from(signSession(payload, sessionSecret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { error: "session_invalid" };
  }
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
    if (session.sub !== ownerId || !Number.isInteger(session.exp) || session.exp <= nowSeconds ||
        !Number.isInteger(session.iat) || session.iat > nowSeconds + 30 ||
        typeof session.nonce !== "string" || !session.nonce) {
      return { error: "session_expired" };
    }
    return { session };
  } catch {
    return { error: "session_invalid" };
  }
}

export function createMiniAppRouter(
  env: Env = process.env,
  options: {
    now?: () => number;
    validate?: (raw: string, token: string, options: { nowSeconds: number; maxAgeSeconds: number }) => VerifiedInitData;
    media?: MiniAppMediaRouteOptions;
    textAi?: TextAiAdapter;
    ownerDossierContext?: (ownerId: string, message: string) => string;
  } = {},
) {
  if (!miniAppConfigEnabled(env)) throw new Error("Mini App staging route is not enabled.");
  const origin = env.ELI_MINI_APP_ORIGIN!;
  const ownerId = env.OWNER_TELEGRAM_ID!;
  const botToken = env.TELEGRAM_BOT_TOKEN!;
  const sessionSecret = env.SESSION_SECRET!;
  const now = options.now || Date.now;
  const validate = options.validate || validateTelegramInitData;
  const mediaEnabled = env.ELI_MINI_APP_MEDIA_MOCK_ENABLED === "true";
  const textAiEnabled = env.ELI_MINI_APP_TEXT_AI_ENABLED === "true";
  const ownerDossierEnabled = env.NODE_ENV === "development" &&
    env.ELI_MINI_APP_OWNER_DOSSIER_ENABLED === "true";
  const textAiKeyAvailable = OPENAI_KEY_FORMAT.test(env.OPENAI_API_KEY || "");
  const activeTextAiSessions = new Set<string>();
  const textAiMinuteRequests = new Map<string, number[]>();
  const textAiDailyRequests = new Map<string, { day: string; count: number }>();
  const usedInitData = new Map<string, number>();
  const chatRequestsBySession = new Map<string, number[]>();
  const router = Router();

  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.path.startsWith("/media/") && !mediaEnabled) {
      sendError(res, 404, "not_found");
      return;
    }
    if (req.get("Origin") !== origin) {
      sendError(res, 403, "origin_forbidden");
      return;
    }
    next();
  });
  router.use(cors({
    origin,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    maxAge: 300,
  }));
  router.use((req, res, next) => {
    if (req.method === "POST" && !req.path.startsWith("/media/") && !req.is("application/json")) {
      sendError(res, 415, "json_required");
      return;
    }
    next();
  });
  router.use(express.json({ limit: "24kb" }));

  router.post("/session", (req, res) => {
    const body = req.body;
    if (!body || Object.keys(body).length !== 1 || typeof body.initData !== "string") {
      sendError(res, 400, "invalid_request");
      return;
    }

    const timestamp = now();
    for (const [key, expiresAt] of usedInitData) {
      if (expiresAt <= timestamp) usedInitData.delete(key);
    }
    const fingerprint = createHash("sha256").update(body.initData).digest("hex");
    if (usedInitData.has(fingerprint)) {
      const existing = readValidSession(req, ownerId, sessionSecret, Math.floor(timestamp / 1000));
      if ("session" in existing) {
        res.json({
          ok: true,
          expiresAt: new Date(existing.session.exp * 1000).toISOString(),
        });
        return;
      }
      sendError(res, 401, "init_data_replayed");
      return;
    }
    if (usedInitData.size >= 1000) {
      sendError(res, 429, "session_rate_limited");
      return;
    }

    let identity: VerifiedInitData;
    try {
      identity = validate(body.initData, botToken, {
        nowSeconds: Math.floor(now() / 1000),
        maxAgeSeconds: INIT_DATA_MAX_AGE_SECONDS,
      });
    } catch {
      sendError(res, 401, "invalid_init_data");
      return;
    }
    if (identity.telegramUserId !== ownerId) {
      sendError(res, 403, "owner_only");
      return;
    }

    usedInitData.set(fingerprint, timestamp + SESSION_TTL_SECONDS * 1000);

    const issuedAt = Math.floor(timestamp / 1000);
    const payload = Buffer.from(JSON.stringify({
      sub: ownerId,
      iat: issuedAt,
      exp: issuedAt + SESSION_TTL_SECONDS,
      nonce: randomBytes(16).toString("base64url"),
    })).toString("base64url");
    const value = `${payload}.${signSession(payload, sessionSecret)}`;
    res.setHeader("Set-Cookie", `${COOKIE}=${value}; Max-Age=${SESSION_TTL_SECONDS}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`);
    res.status(200).json({ ok: true, expiresAt: new Date((issuedAt + SESSION_TTL_SECONDS) * 1000).toISOString() });
  });

  const requireOwnerSession = (req: Request, res: Response, next: NextFunction) => {
    const verified = readValidSession(req, ownerId, sessionSecret, Math.floor(now() / 1000));
    if (!("session" in verified)) {
      sendError(res, 401, verified.error);
      return;
    }
    res.locals.miniAppSessionNonce = verified.session.nonce;
    res.locals.miniAppOwnerId = verified.session.sub;
    next();
  };

  const configuredTextAi: TextAiAdapter = options.textAi ||
    createOpenAiTextAiAdapter(env.OPENAI_API_KEY || "");
  const buildOwnerDossierContext = options.ownerDossierContext || ((verifiedOwnerId: string, message: string) => {
    if (verifiedOwnerId !== ownerId || verifiedOwnerId !== env.OWNER_TELEGRAM_ID) return "";
    const dossierPrompt = (ownerDossier as {
      buildOwnerDossierPrompt: (id: string, question: string) => string;
    }).buildOwnerDossierPrompt(verifiedOwnerId, message);
    return dossierPrompt;
  });

  registerMiniAppMediaRoutes(router, requireOwnerSession, mediaEnabled, env, options.media);

  // POST is intentional: browsers include Origin on same-origin POST requests,
  // while same-origin GET requests commonly omit it and fail the router's CSRF check.
  router.post("/text-ai/status", requireOwnerSession, (_req, res) => {
    if (!textAiEnabled) {
      res.json({ mode: "mock", ownerDossierContext: false });
      return;
    }
    if (!textAiKeyAvailable) {
      sendError(res, 503, "text_ai_unavailable");
      return;
    }
    res.json({
      mode: "test_ai",
      model: TEXT_AI_MODEL,
      ownerDossierContext: ownerDossierEnabled,
    });
  });

  router.post("/text-ai", requireOwnerSession, async (req, res) => {
    if (!textAiEnabled) {
      sendError(res, 404, "not_found");
      return;
    }
    if (!textAiKeyAvailable) {
      sendError(res, 503, "text_ai_unavailable");
      return;
    }
    const body = req.body;
    if (
      !body ||
      Object.keys(body).some((key) => !["message", "language"].includes(key)) ||
      typeof body.message !== "string" ||
      !body.message.trim() ||
      body.message.length > TEXT_AI_MAX_INPUT_CHARS ||
      (body.language !== undefined && body.language !== "bg" && body.language !== "en")
    ) {
      sendError(res, 400, "invalid_request");
      return;
    }

    if (activeTextAiSessions.has(ownerId)) {
      sendError(res, 429, "text_ai_in_progress");
      return;
    }
    const current = now();
    const minuteRequests = (textAiMinuteRequests.get(ownerId) || [])
      .filter((time) => current - time < 60_000);
    if (minuteRequests.length >= TEXT_AI_MINUTE_LIMIT) {
      sendError(res, 429, "text_ai_rate_limited");
      return;
    }
    const day = new Date(current).toISOString().slice(0, 10);
    const daily = textAiDailyRequests.get(ownerId);
    const dailyCount = daily?.day === day ? daily.count : 0;
    if (dailyCount >= TEXT_AI_DAILY_LIMIT) {
      sendError(res, 429, "text_ai_daily_limit");
      return;
    }

    let ownerDossierContext: string | undefined;
    if (ownerDossierEnabled) {
      const verifiedOwnerId = res.locals.miniAppOwnerId as string;
      if (verifiedOwnerId !== ownerId || verifiedOwnerId !== env.OWNER_TELEGRAM_ID) {
        sendError(res, 403, "owner_only");
        return;
      }
      try {
        ownerDossierContext = buildOwnerDossierContext(verifiedOwnerId, body.message.trim());
      } catch {
        sendError(res, 503, "owner_memory_unavailable");
        return;
      }
    }

    // Reserve quota before calling the provider; failed/ambiguous calls are not retried.
    minuteRequests.push(current);
    textAiMinuteRequests.set(ownerId, minuteRequests);
    textAiDailyRequests.set(ownerId, { day, count: dailyCount + 1 });
    activeTextAiSessions.add(ownerId);
    try {
      const reply = await configuredTextAi({
        message: body.message.trim(),
        language: body.language === "en" ? "en" : "bg",
        ...(ownerDossierContext ? { ownerDossierContext } : {}),
      });
      res.json({ reply, mode: "test_ai", model: TEXT_AI_MODEL });
    } catch (error) {
      const code = error instanceof Error && error.message === "provider_rate_limited"
        ? "text_ai_provider_rate_limited"
        : error instanceof Error && error.name === "TimeoutError"
          ? "text_ai_timeout"
          : "text_ai_provider_unavailable";
      const status = code === "text_ai_provider_rate_limited" ? 429 : 503;
      sendError(res, status, code);
    } finally {
      activeTextAiSessions.delete(ownerId);
    }
  });

  router.post("/demo-chat", requireOwnerSession, (req, res) => {
    const body = req.body;
    if (
      !body ||
      Object.keys(body).some((key) => !["message", "language"].includes(key)) ||
      typeof body.message !== "string" ||
      !body.message.trim() ||
      body.message.length > 1200 ||
      (body.language !== undefined && body.language !== "bg" && body.language !== "en")
    ) {
      sendError(res, 400, "invalid_request");
      return;
    }
    const nonce = res.locals.miniAppSessionNonce as string;
    const current = now();
    const recent = (chatRequestsBySession.get(nonce) || []).filter((time) => current - time < 60_000);
    if (recent.length >= 20) {
      sendError(res, 429, "chat_rate_limited");
      return;
    }
    recent.push(current);
    chatRequestsBySession.set(nonce, recent);
    if (chatRequestsBySession.size > 1000) {
      for (const [key, times] of chatRequestsBySession) {
        if (!times.length || current - times[times.length - 1] >= 60_000) chatRequestsBySession.delete(key);
      }
    }
    res.json({ reply: STATIC_REPLIES[body.language === "en" ? "en" : "bg"], demo: true });
  });

  router.use((_req, res) => sendError(res, 404, "not_found"));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number })?.status === 413 ? 413 : 400;
    sendError(res, status, status === 413 ? "request_too_large" : "invalid_request");
  });
  return router;
}

export function mountMiniAppRoutes(
  app: Application,
  env: Env = process.env,
  options: Parameters<typeof createMiniAppRouter>[1] = {},
): boolean {
  if (!miniAppConfigEnabled(env)) return false;
  app.use("/api/mini-app", createMiniAppRouter(env, options));
  return true;
}
