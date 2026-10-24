import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import express, { Router, type Application, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReadMiniAppProfileSnapshotBody,
  ReadMiniAppProfileSnapshotResponse,
  PostMiniAppTextTurnBody,
  PostMiniAppTextTurnResponse,
  PostMiniAppMutationBody,
  PostMiniAppMutationResponse,
  PostMiniAppCoachingBody,
  PostMiniAppCoachingResponse,
} from "../../../../lib/api-zod/src/generated/api.ts";
import { validateTelegramInitData } from "../lib/telegramInitData.mjs";
// @ts-expect-error Shared HMAC protocol; claims are signed from verified session subjects only.
import miniAppBridgeAuth from "../../../../bot/miniAppBridgeAuth.js";
// @ts-expect-error The CommonJS persona module is the canonical prompt shared with the Telegram bot.
import eliPersona from "../../../../bot/persona.js";
// @ts-expect-error The selector rechecks the owner and filters dossier facts by message topic.
import ownerDossier from "../../../../bot/ownerDossier.js";
// @ts-expect-error Reuse only canonical owner identity facts, never the full bot prompt.
import ownerContext from "../../../../bot/ownerContext.js";
import {
  registerMiniAppMediaRoutes,
  type MiniAppMediaRouteOptions,
} from "./miniAppMedia.ts";

const COOKIE = "eli_mini_session";
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
const { OWNER_NAME, OWNER_CREATOR_FACT } = ownerContext as {
  OWNER_NAME: string;
  OWNER_CREATOR_FACT: string;
};
declare const __ELI_CANONICAL_OWNER_DOSSIER_PATH__: string;
type SessionClaims = { sub: string; iat: number; exp: number; nonce: string };

type Env = NodeJS.ProcessEnv;
type VerifiedInitData = ReturnType<typeof validateTelegramInitData>;
type MiniAppLanguage = "bg" | "en";
type TextAiAdapter = (input: {
  message: string;
  language: MiniAppLanguage;
  ownerDossierContext?: string;
}) => Promise<string>;
type OwnerDossierFaq = {
  detectOwnerDossierQuestion: (message: string) => string | null;
  answerOwnerDossierQuestion: (ownerId: string, intent: string) => string;
};
type MiniAppSnapshot = Record<string, unknown>;

function ownerDossierFaqIntents(message: string, detect: OwnerDossierFaq["detectOwnerDossierQuestion"]): string[] {
  const text = message.toLocaleLowerCase("bg");
  const asksMotivation =
    /(личн.{0,25}мотивац|мотивац.{0,50}(бизнес|създа|постиг)|защо.{0,50}(създад|създам|направ|изград).{0,40}(бизнес|ели)|с каква цел.{0,50}(създад|направ|изград))/.test(text);
  const asksGoals =
    /(какво.{0,40}(искам|мога|трябва).{0,30}постиг|какви са.{0,30}(цел|мечт)|каква е.{0,30}(цел|мечт)|целите ми|моите цели|мечтата ми)/.test(text);
  const asksMission =
    /(мисията ми|моята мисия|мисия на бизнеса|бизнес мисия|мисията на бизнеса|what is (my|our|the business) mission|business mission)/.test(text);
  const intents: string[] = [];
  if (asksMotivation) intents.push("creation_reason");
  if (asksGoals) intents.push("goals");
  if (asksMission && !intents.length) intents.push("business_mission");

  // Prefer explicit personal questions over a mention of Eli's mission, which
  // the legacy detector can otherwise classify as the business-mission FAQ.
  if (intents.length) return intents;
  const legacyIntent = detect(message);
  return legacyIntent === "creation_reason" || legacyIntent === "goals"
    ? [legacyIntent]
    : [];
}

function ownerIdentityFaqReply(message: string): string | null {
  const text = message.toLocaleLowerCase("bg").replace(/[’']/g, "'");
  if (
    /(как се казвам|какво е името ми|кое е името ми|как ме наричаш|как се казва собственикът|what is my name|what's my name|what is the owner's name)/.test(text)
  ) {
    return `Казваш се ${OWNER_NAME}.`;
  }
  if (
    /(кой.{0,20}(създа|направ|изград).{0,35}(ели|теб|здраве на автопилот)|създател(ят)? на (ели|здраве на автопилот)|who (created|made|built) (you|eli|health on autopilot)|who is the creator of eli)/.test(text)
  ) {
    return `Ели е създадена от ${OWNER_NAME} — ${OWNER_CREATOR_FACT.toLocaleLowerCase("bg")}.`;
  }
  return null;
}

function canonicalOwnerDossierPath(): string {
  if (typeof __ELI_CANONICAL_OWNER_DOSSIER_PATH__ === "string" &&
      path.isAbsolute(__ELI_CANONICAL_OWNER_DOSSIER_PATH__) &&
      __ELI_CANONICAL_OWNER_DOSSIER_PATH__) {
    return __ELI_CANONICAL_OWNER_DOSSIER_PATH__;
  }
  // Source-level tests use this branch. Bundled development builds receive the
  // absolute path from build.mjs, so runtime cwd and dist placement are irrelevant.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../bot/owner_dossier.json");
}

function withOwnerDossierPath<T>(filePath: string, read: () => T): T {
  if (!path.isAbsolute(filePath)) throw new Error("owner_dossier_path_invalid");
  const stat = statSync(filePath);
  if (!stat.isFile()) throw new Error("owner_dossier_not_file");
  accessSync(filePath, fsConstants.R_OK);

  // ownerDossier resolves its configured path per read. Scope this override to
  // the synchronous canonical read so it cannot leak into other API requests.
  const previousPath = process.env.OWNER_DOSSIER_PATH;
  process.env.OWNER_DOSSIER_PATH = filePath;
  try {
    return read();
  } finally {
    if (previousPath === undefined) delete process.env.OWNER_DOSSIER_PATH;
    else process.env.OWNER_DOSSIER_PATH = previousPath;
  }
}

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
  const stageMatchesRuntime =
    (env.NODE_ENV === "development" && env.ELI_MINI_APP_STAGE === "staging") ||
    (env.NODE_ENV === "production" && env.ELI_MINI_APP_STAGE === "production");
  return stageMatchesRuntime &&
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
    if (!/^[1-9]\d{4,19}$/.test(session.sub) ||
        !Number.isInteger(session.exp) || session.exp <= nowSeconds ||
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
    ownerDossierFaq?: OwnerDossierFaq;
    ownerDossierPath?: string;
    readProfileSnapshot?: (userId: string) => Promise<MiniAppSnapshot>;
    bridgeSecret?: string;
    bridgeFetch?: typeof fetch;
  } = {},
) {
  if (!miniAppConfigEnabled(env)) throw new Error("Mini App staging route is not enabled.");
  const origin = env.ELI_MINI_APP_ORIGIN!;
  const ownerId = env.OWNER_TELEGRAM_ID!;
  const botToken = env.TELEGRAM_BOT_TOKEN!;
  const sessionSecret = env.SESSION_SECRET!;
  const bridgeSecret = options.bridgeSecret ?? env.ELI_MEMORY_INTERNAL_SECRET ?? "";
  const bridgeFetch = options.bridgeFetch ?? fetch;
  const now = options.now || Date.now;
  const validate = options.validate || validateTelegramInitData;
  const mediaEnabled = env.NODE_ENV === "development" &&
    env.ELI_MINI_APP_STAGE === "staging" &&
    env.ELI_MINI_APP_MEDIA_MOCK_ENABLED === "true";
  const voiceTurnEnabled = env.ELI_MINI_APP_VOICE_ENABLED === "true";
  const textAiEnabled = env.ELI_MINI_APP_TEXT_AI_ENABLED === "true";
  const ownerDossierEnabled = env.NODE_ENV === "development" &&
    env.ELI_MINI_APP_STAGE === "staging" &&
    env.ELI_MINI_APP_OWNER_DOSSIER_ENABLED === "true";
  const ownerOnlyStage = env.NODE_ENV === "development" &&
    env.ELI_MINI_APP_STAGE === "staging";
  const ownerDossierPath = ownerDossierEnabled
    ? options.ownerDossierPath || canonicalOwnerDossierPath()
    : undefined;
  const textAiKeyAvailable = OPENAI_KEY_FORMAT.test(env.OPENAI_API_KEY || "");
  const activeTextAiSessions = new Set<string>();
  const textAiMinuteRequests = new Map<string, number[]>();
  const textAiDailyRequests = new Map<string, { day: string; count: number }>();
  const usedInitData = new Map<string, { expiresAt: number; userId: string }>();
  const chatRequestsBySession = new Map<string, number[]>();
  const router = Router();

  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.path.startsWith("/media/") && !mediaEnabled &&
        !(req.path === "/media/voice" && voiceTurnEnabled)) {
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
    for (const [key, use] of usedInitData) {
      if (use.expiresAt <= timestamp) usedInitData.delete(key);
    }
    const canonicalFields = [...new URLSearchParams(body.initData).entries()]
      .map(([key, value]) => [key, key === "hash" ? value.toLowerCase() : value] as [string, string])
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const fingerprint = createHash("sha256")
      .update(new URLSearchParams(canonicalFields).toString())
      .digest("hex");
    const previousUse = usedInitData.get(fingerprint);
    if (previousUse) {
      const existing = readValidSession(req, sessionSecret, Math.floor(timestamp / 1000));
      if ("session" in existing &&
          previousUse.userId === existing.session.sub &&
          (!ownerOnlyStage || existing.session.sub === ownerId)) {
        res.json({
          ok: true,
          expiresAt: new Date(existing.session.exp * 1000).toISOString(),
        });
        return;
      }
      sendError(res, 401, "init_data_replayed");
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
    if (!/^[1-9]\d{4,19}$/.test(identity.telegramUserId)) {
      sendError(res, 401, "invalid_init_data");
      return;
    }
    if (ownerOnlyStage && identity.telegramUserId !== ownerId) {
      sendError(res, 403, "owner_only");
      return;
    }
    if (usedInitData.size >= 1000) {
      sendError(res, 429, "session_rate_limited");
      return;
    }

    usedInitData.set(fingerprint, {
      expiresAt: timestamp + SESSION_TTL_SECONDS * 1000,
      userId: identity.telegramUserId,
    });

    const issuedAt = Math.floor(timestamp / 1000);
    const payload = Buffer.from(JSON.stringify({
      sub: identity.telegramUserId,
      iat: issuedAt,
      exp: issuedAt + SESSION_TTL_SECONDS,
      nonce: randomBytes(16).toString("base64url"),
    })).toString("base64url");
    const value = `${payload}.${signSession(payload, sessionSecret)}`;
    res.setHeader("Set-Cookie", `${COOKIE}=${value}; Max-Age=${SESSION_TTL_SECONDS}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`);
    res.status(200).json({ ok: true, expiresAt: new Date((issuedAt + SESSION_TTL_SECONDS) * 1000).toISOString() });
  });

  const requireSession = (req: Request, res: Response, next: NextFunction) => {
    const verified = readValidSession(req, sessionSecret, Math.floor(now() / 1000));
    if (!("session" in verified)) {
      sendError(res, 401, verified.error);
      return;
    }
    res.locals.miniAppSessionNonce = verified.session.nonce;
    res.locals.miniAppUserId = verified.session.sub;
    next();
  };
  const requireOwnerSession = (req: Request, res: Response, next: NextFunction) => {
    requireSession(req, res, () => {
      if (res.locals.miniAppUserId !== ownerId) {
        sendError(res, 403, "owner_only");
        return;
      }
      res.locals.miniAppOwnerId = res.locals.miniAppUserId;
      next();
    });
  };

  // Keep development staging owner-only. Production uses the validated
  // per-user Telegram session for every route registered after this point.
  router.use((req, res, next) => {
    if (req.path === "/session") return next();
    return ownerOnlyStage
      ? requireOwnerSession(req, res, next)
      : requireSession(req, res, next);
  });

  const readProfileSnapshot = options.readProfileSnapshot || (async (userId: string) => {
    if (bridgeSecret.trim().length < 32) throw new Error("profile_service_unavailable");
    const claim = (miniAppBridgeAuth as {
      createClaim: (userId: string, secret: string) => string;
    }).createClaim(userId, bridgeSecret);
    const response = await bridgeFetch("http://127.0.0.1:3001/internal/mini-app/profile-snapshot", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${claim}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("profile_service_unavailable");
    const body = await response.json() as { ok?: unknown; snapshot?: unknown };
    if (body?.ok !== true || !body.snapshot || typeof body.snapshot !== "object" ||
        Array.isArray(body.snapshot)) throw new Error("profile_service_invalid_response");
    return body.snapshot as MiniAppSnapshot;
  });

  router.post("/profile", requireSession, async (req, res): Promise<void> => {
    const requestBody = ReadMiniAppProfileSnapshotBody.safeParse(req.body);
    if (!requestBody.success || !req.body || Object.keys(req.body).length !== 0) {
      sendError(res, 400, "invalid_request");
      return;
    }
    try {
      const userId = res.locals.miniAppUserId as string;
      const snapshot = await readProfileSnapshot(userId);
      res.setHeader("Cache-Control", "no-store");
      res.json(ReadMiniAppProfileSnapshotResponse.parse({ mode: "read_only", snapshot }));
    } catch {
      sendError(res, 503, "profile_service_unavailable");
    }
  });

  router.post("/chat", requireSession, async (req, res): Promise<void> => {
    const parsed = PostMiniAppTextTurnBody.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "invalid_request");
      return;
    }
    if (bridgeSecret.trim().length < 32) {
      sendError(res, 503, "text_engine_unavailable");
      return;
    }
    try {
      const userId = res.locals.miniAppUserId as string;
      const claim = (miniAppBridgeAuth as {
        createClaim: (userId: string, secret: string, now?: number, path?: string) => string;
      }).createClaim(userId, bridgeSecret, undefined, "/internal/mini-app/text-turn");
      const response = await bridgeFetch("http://127.0.0.1:3001/internal/mini-app/text-turn", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${claim}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          message: parsed.data.message,
          mode: parsed.data.mode || "text",
          turnId: parsed.data.turnId,
        }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(260_000),
      });
      if (!response.ok) {
        sendError(res, response.status === 429 ? 429 : 503,
          response.status === 429 ? "text_rate_limited" : "text_engine_unavailable");
        return;
      }
      const body = await response.json() as {
        ok?: unknown;
        reply?: unknown;
        kind?: unknown;
        media?: unknown;
      };
      res.json(PostMiniAppTextTurnResponse.parse({
        reply: body.reply,
        kind: body.kind,
        media: body.media,
      }));
    } catch (error) {
      const timeout = error instanceof Error && error.name === "TimeoutError";
      sendError(res, timeout ? 504 : 503, timeout ? "text_engine_timeout" : "text_engine_unavailable");
    }
  });

  router.post("/coaching", requireSession, async (req, res): Promise<void> => {
    const parsed = PostMiniAppCoachingBody.safeParse(req.body);
    if (!parsed.success || bridgeSecret.trim().length < 32) {
      sendError(res, parsed.success ? 503 : 400, parsed.success ? "coach_unavailable" : "invalid_request");
      return;
    }
    try {
      const userId = res.locals.miniAppUserId as string;
      const claim = (miniAppBridgeAuth as {
        createClaim: (userId: string, secret: string, now?: number, path?: string) => string;
      }).createClaim(userId, bridgeSecret, undefined, "/internal/mini-app/coach-turn");
      const response = await bridgeFetch("http://127.0.0.1:3001/internal/mini-app/coach-turn", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${claim}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(parsed.data),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(260_000),
      });
      let body: unknown;
      try { body = await response.json(); } catch { body = null; }
      if (!response.ok) {
        const code = body && typeof body === "object" && "error" in body &&
          typeof body.error === "string" && /^[a-z0-9_]{1,48}$/.test(body.error)
          ? body.error : "coach_unavailable";
        sendError(res, response.status === 429 ? 429 : response.status === 400 ? 400 : 503, code);
        return;
      }
      if (!body || typeof body !== "object") {
        sendError(res, 503, "coach_unavailable");
        return;
      }
      const result = body as { kind?: unknown; text?: unknown };
      res.json(PostMiniAppCoachingResponse.parse({ kind: result.kind, text: result.text }));
    } catch (error) {
      const timeout = error instanceof Error && error.name === "TimeoutError";
      sendError(res, timeout ? 504 : 503, timeout ? "coach_timeout" : "coach_unavailable");
    }
  });

  router.post("/mutations", requireSession, async (req, res): Promise<void> => {
    const parsed = PostMiniAppMutationBody.safeParse(req.body);
    if (!parsed.success || !bridgeSecret.trim() || bridgeSecret.trim().length < 32) {
      sendError(res, parsed.success ? 503 : 400, parsed.success ? "mutation_unavailable" : "invalid_request");
      return;
    }
    try {
      const userId = res.locals.miniAppUserId as string;
      const claim = (miniAppBridgeAuth as {
        createClaim: (userId: string, secret: string, now?: number, path?: string) => string;
      }).createClaim(userId, bridgeSecret, undefined, "/internal/mini-app/mutate");
      const response = await bridgeFetch("http://127.0.0.1:3001/internal/mini-app/mutate", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${claim}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(parsed.data),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      let body: unknown;
      try { body = await response.json(); } catch { body = null; }
      if (!response.ok) {
        const code = body && typeof body === "object" && "error" in body &&
          typeof body.error === "string" && /^[a-z0-9_]{1,48}$/.test(body.error)
          ? body.error : "mutation_unavailable";
        const status = [400, 403, 404, 422].includes(response.status) ? response.status : 503;
        sendError(res, status, code);
        return;
      }
      res.json(PostMiniAppMutationResponse.parse(body));
    } catch {
      sendError(res, 503, "mutation_unavailable");
    }
  });

  const configuredTextAi: TextAiAdapter = options.textAi ||
    createOpenAiTextAiAdapter(env.OPENAI_API_KEY || "");
  const buildOwnerDossierContext = options.ownerDossierContext || ((verifiedOwnerId: string, message: string) => {
    if (verifiedOwnerId !== ownerId || verifiedOwnerId !== env.OWNER_TELEGRAM_ID) return "";
    const dossierPrompt = (ownerDossier as {
      buildOwnerDossierPrompt: (id: string, question: string) => string;
    }).buildOwnerDossierPrompt(verifiedOwnerId, message);
    return dossierPrompt;
  });
  const ownerDossierFaq = options.ownerDossierFaq || (ownerDossier as OwnerDossierFaq);

  const processVoiceTurn = async (input: {
    userId: string;
    audio: Buffer;
    mode: "text" | "voice" | "avatar";
    turnId: string;
    prompt: string;
  }): Promise<Record<string, unknown>> => {
    if (bridgeSecret.trim().length < 32) throw new Error("voice_turn_unavailable");
    const claim = (miniAppBridgeAuth as {
      createClaim: (userId: string, secret: string, now?: number, path?: string) => string;
    }).createClaim(input.userId, bridgeSecret, undefined, "/internal/mini-app/voice-turn");
    const response = await bridgeFetch("http://127.0.0.1:3001/internal/mini-app/voice-turn", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${claim}`,
        "Content-Type": "application/octet-stream",
        Accept: "application/json",
        "X-Eli-Mode": input.mode,
        "X-Eli-Turn-Id": input.turnId,
        "X-Eli-Prompt": Buffer.from(input.prompt, "utf8").toString("base64url"),
      },
      body: new Uint8Array(input.audio),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(260_000),
    });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok || body.ok !== true ||
        typeof body.transcript !== "string" || typeof body.reply !== "string" ||
        !["eli_text", "voice", "avatar", "access_denied", "transcription_unclear"].includes(String(body.kind))) {
      throw new Error("voice_turn_unavailable");
    }
    const { ok: _ok, ...result } = body;
    return result;
  };
  registerMiniAppMediaRoutes(
    router,
    ownerOnlyStage ? requireOwnerSession : requireSession,
    mediaEnabled,
    env,
    {
      ...options.media,
      voiceTurnEnabled,
      processVoiceTurn,
    },
  );

  // These legacy staging routes were replaced by /chat, which calls only the
  // bot-owned text engine. Keep old URLs inert so stale clients fail closed.
  router.use((req, res, next) => {
    const legacyPath = req.path.toLowerCase().replace(/\/+$/, "");
    if (legacyPath === "/text-ai" ||
        legacyPath === "/text-ai/status") {
      sendError(res, 404, "not_found");
      return;
    }
    next();
  });

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

    const identityReply = ownerIdentityFaqReply(body.message.trim());
    if (identityReply) {
      res.json({ reply: identityReply, mode: "owner_identity_faq" });
      return;
    }
    if (!textAiKeyAvailable) {
      sendError(res, 503, "text_ai_unavailable");
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
        const faqIntents = ownerDossierFaqIntents(
          body.message.trim(),
          ownerDossierFaq.detectOwnerDossierQuestion,
        );
        if (faqIntents.length) {
          const reply = withOwnerDossierPath(ownerDossierPath!, () => faqIntents
            .map((intent) => ownerDossierFaq.answerOwnerDossierQuestion(verifiedOwnerId, intent))
            .join("\n\n"));
          res.json({ reply, mode: "owner_dossier_faq" });
          return;
        }
        ownerDossierContext = withOwnerDossierPath(ownerDossierPath!, () =>
          buildOwnerDossierContext(verifiedOwnerId, body.message.trim()),
        );
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
    if (!ownerOnlyStage) {
      sendError(res, 404, "not_found");
      return;
    }
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
