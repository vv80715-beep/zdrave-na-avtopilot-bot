import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { Router, type Application, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { validateTelegramInitData } from "../lib/telegramInitData.mjs";
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
type SessionClaims = { sub: string; iat: number; exp: number; nonce: string };

type Env = NodeJS.ProcessEnv;
type VerifiedInitData = ReturnType<typeof validateTelegramInitData>;

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
    methods: ["POST", "OPTIONS"],
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
    next();
  };

  registerMiniAppMediaRoutes(router, requireOwnerSession, mediaEnabled, env, options.media);

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
