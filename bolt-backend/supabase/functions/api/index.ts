import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createRevolutCheckout, inspectTestCheckoutConfiguration } from "../_shared/revolut-checkout.mjs";

// ---------------------------------------------------------------------------
// Plans (mirrors server/plans.js exactly)
// ---------------------------------------------------------------------------

const PLAN_IDS = ["seven_day", "monthly", "yearly"] as const;
type PlanId = (typeof PLAN_IDS)[number];

const PLANS: Record<PlanId, {
  id: PlanId;
  name: string;
  price: { amount: number; currency: string; display: string };
  durationDays: number;
  modes: readonly string[];
  avatarMinutesPerMonth: number;
}> = {
  seven_day: {
    id: "seven_day",
    name: "7 дни с Ели",
    price: { amount: 15, currency: "EUR", display: "€15" },
    durationDays: 7,
    modes: ["text", "voice", "community"],
    avatarMinutesPerMonth: 0,
  },
  monthly: {
    id: "monthly",
    name: "1 месец с Ели",
    price: { amount: 50, currency: "EUR", display: "€50" },
    durationDays: 30,
    modes: ["text", "voice", "avatar", "community"],
    avatarMinutesPerMonth: 30,
  },
  yearly: {
    id: "yearly",
    name: "1 година с Ели",
    price: { amount: 360, currency: "EUR", display: "€360" },
    durationDays: 365,
    modes: ["text", "voice", "avatar", "community"],
    avatarMinutesPerMonth: 20,
  },
};

const API_VERSION = 1;

function isValidPlanId(id: string | undefined | null): id is PlanId {
  return !!id && (PLAN_IDS as readonly string[]).includes(id);
}

// ---------------------------------------------------------------------------
// Helpers (mirrors server/app.js and server/purchaseSessionService.js)
// ---------------------------------------------------------------------------

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;
const TELEGRAM_USER_ID_RE = /^\d{5,20}$/;

function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function normalizeTelegramUserId(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return TELEGRAM_USER_ID_RE.test(s) ? s : null;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

// ---------------------------------------------------------------------------
// CORS + JSON helpers
// ---------------------------------------------------------------------------

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function sendJson(resInit: { status: number }, body: Record<string, unknown>): Response {
  const payload = JSON.stringify({ api_version: API_VERSION, ...body });
  return new Response(payload, {
    status: resInit.status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function sendError(status: number, code: string, message: string): Response {
  return sendJson({ status }, { error: code, message });
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

function parseUrl(url: string): { segments: string[] } {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split("?")[0];
  }
  const funcPrefix = "/functions/v1/api";
  if (pathname.startsWith(funcPrefix)) {
    pathname = pathname.slice(funcPrefix.length);
  }
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "api") {
    segments.unshift("api");
  }
  return { segments };
}

function getBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

function getSupabaseClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url) throw new Error("SUPABASE_URL is not configured.");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getInternalSecret(): string {
  const secret = Deno.env.get("BOT_PURCHASE_API_SECRET");
  if (!secret || secret === "replace-with-at-least-32-random-characters") {
    throw new Error("BOT_PURCHASE_API_SECRET must be set to a real secret.");
  }
  if (secret.trim().length < 32) {
    throw new Error("BOT_PURCHASE_API_SECRET must be at least 32 characters long.");
  }
  return secret;
}

const DEFAULT_APP_BASE_URL = "https://zdrave-na-avtopilot-dkr6.bolt.host";

function getAppBaseUrl(_req?: Request): string {
  const configured = (Deno.env.get("APP_BASE_URL") || "").replace(/\/+$/, "");
  if (configured) return configured;
  return DEFAULT_APP_BASE_URL;
}

// ---------------------------------------------------------------------------
// Purchase session store
// ---------------------------------------------------------------------------

interface PurchaseSession {
  id: string;
  token_hash: string;
  telegram_user_id: number;
  plan_id: string;
  status: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
  updated_at: string;
  stripe_checkout_session_id: string | null;
  stripe_checkout_expires_at: string | null;
  checkout_created_at: string | null;
  checkout_provider?: string | null;
  checkout_reference?: string | null;
}

async function createPurchaseSession(client: ReturnType<typeof getSupabaseClient>, { id, tokenHash, telegramUserId, planId, expiresAt }: { id: string; tokenHash: string; telegramUserId: string; planId: string; expiresAt: Date; }): Promise<void> {
  const { error } = await client.from("purchase_sessions").insert({ id, token_hash: tokenHash, telegram_user_id: Number(telegramUserId), plan_id: planId, status: "pending", expires_at: expiresAt.toISOString() });
  if (error) throw error;
}

async function findByTokenHash(client: ReturnType<typeof getSupabaseClient>, tokenHash: string): Promise<PurchaseSession | null> {
  const { data, error } = await client.from("purchase_sessions").select("*").eq("token_hash", tokenHash).maybeSingle();
  if (error) throw error;
  return data as PurchaseSession | null;
}

async function updateSessionStatus(client: ReturnType<typeof getSupabaseClient>, tokenHash: string, status: string, extra: Record<string, unknown> = {}): Promise<PurchaseSession | null> {
  const now = new Date().toISOString();
  const { data, error } = await client.from("purchase_sessions").update({ status, updated_at: now, ...extra }).eq("token_hash", tokenHash).select().maybeSingle();
  if (error) throw error;
  return data as PurchaseSession | null;
}

async function claimForCheckout(client: ReturnType<typeof getSupabaseClient>, tokenHash: string): Promise<PurchaseSession | null> {
  const now = new Date().toISOString();
  const { data, error } = await client.from("purchase_sessions").update({ status: "pending", updated_at: now }).eq("token_hash", tokenHash).in("status", ["pending", "checkout_created"]).is("stripe_checkout_session_id", null).select().maybeSingle();
  if (error) throw error;
  return data as PurchaseSession | null;
}

function errorResult(code: string, message: string, status: number) {
  return { ok: false as const, status, body: { api_version: API_VERSION, error: code, message } };
}

async function createPurchaseSessionService(client: ReturnType<typeof getSupabaseClient>, { telegramUserId, planId, appBaseUrl }: { telegramUserId: unknown; planId: unknown; appBaseUrl: string }): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const userId = normalizeTelegramUserId(telegramUserId);
  if (!userId) return errorResult("invalid_telegram_user", "Невалиден Telegram user ID.", 400);
  if (!isValidPlanId(planId as string)) return errorResult("invalid_plan", "Невалиден canonical plan.", 400);
  const token = generateToken();
  const tokenHash = await hashToken(token);
  const id = crypto.randomUUID();
  const createdAt = new Date();
  const ttlMinutes = Number(Deno.env.get("PURCHASE_SESSION_TTL_MINUTES") || 15);
  const expiresAt = new Date(createdAt.getTime() + ttlMinutes * 60_000);
  await createPurchaseSession(client, { id, tokenHash, telegramUserId: userId, planId: planId as string, expiresAt });
  const plan = PLANS[planId as PlanId];
  const purchaseUrl = `${appBaseUrl}/confirm-plan.html?session=${token}`;
  return { ok: true, status: 201, body: { api_version: API_VERSION, purchase_url: purchaseUrl, expires_at: expiresAt.toISOString(), plan: { id: plan.id, name: plan.name } } };
}

async function verifySessionService(client: ReturnType<typeof getSupabaseClient>, token: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const normalized = String(token ?? "").trim();
  if (!TOKEN_RE.test(normalized)) return errorResult("invalid_session_token", "Невалиден session token.", 400);
  const tokenHash = await hashToken(normalized);
  const session = await findByTokenHash(client, tokenHash);
  if (!session) return errorResult("session_not_found", "Сесията не е намерена.", 404);
  const now = new Date();
  if (session.expires_at && new Date(session.expires_at).getTime() <= now.getTime()) {
    if (session.status === "pending") await updateSessionStatus(client, tokenHash, "expired");
    return errorResult("session_expired", "Сесията е изтекла.", 410);
  }
  if (session.status === "cancelled" || session.status === "paid") return errorResult("session_consumed", "Сесията вече е използвана.", 410);
  const plan = PLANS[session.plan_id as PlanId] || { id: session.plan_id, name: session.plan_id };
  return { ok: true, status: 200, body: { api_version: API_VERSION, plan_id: plan.id, plan: { id: plan.id, name: plan.name }, status: session.status, expires_at: new Date(session.expires_at).toISOString() } };
}

// ---------------------------------------------------------------------------
// Entitlement + Avatar usage
// ---------------------------------------------------------------------------

async function getInternalEntitlement(client: ReturnType<typeof getSupabaseClient>, telegramUserId: string): Promise<Record<string, unknown> | null> {
  const userId = String(telegramUserId).trim();
  if (!TELEGRAM_USER_ID_RE.test(userId)) return null;
  const { data, error } = await client.from("entitlements").select("*").eq("telegram_user_id", Number(userId)).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const plan = PLANS[data.plan_id as PlanId] || { id: data.plan_id, name: data.plan_id, modes: [], avatarMinutesPerMonth: 0 };
  const now = new Date();
  const expiresAt = data.expires_at ? new Date(data.expires_at) : null;
  const active = data.status === "active" && expiresAt && expiresAt.getTime() > now.getTime();
  return { telegram_user_id: String(data.telegram_user_id), active, plan_id: data.plan_id, plan: { id: plan.id, name: plan.name }, status: data.status, billing_status: data.billing_status, modes: active ? plan.modes : [], avatar_minutes_per_month: active ? plan.avatarMinutesPerMonth : 0, starts_at: data.starts_at, current_period_start: data.current_period_start, current_period_end: data.current_period_end, expires_at: data.expires_at, cancel_at_period_end: data.cancel_at_period_end, stripe_subscription_id: data.stripe_subscription_id || null };
}

interface AvatarUsageSnapshot { plan_active: boolean; avatar_access: boolean; can_create_avatar: boolean; period_start: string | null; period_end: string | null; included_allowance_seconds: number; included_used_seconds: number; included_remaining_seconds: number; addon_purchased_seconds: number; addon_used_seconds: number; addon_remaining_seconds: number; addon_locked: boolean; available_seconds: number; }

function addUtcMonthsClamped(value: Date, months: number): Date {
  const targetFirst = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1, value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(), value.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth() + 1, 0)).getUTCDate();
  targetFirst.setUTCDate(Math.min(value.getUTCDate(), lastDay));
  return targetFirst;
}

function resolveAvatarUsagePeriod(entitlement: Record<string, unknown>, plan: (typeof PLANS)[PlanId]): { start: string | null; end: string | null } {
  const rawStart = entitlement.current_period_start;
  const rawEnd = entitlement.current_period_end;
  if (typeof rawStart !== "string" || typeof rawEnd !== "string") return { start: null, end: null };
  if (plan.id !== "yearly") return { start: rawStart, end: rawEnd };
  const startsAtRaw = typeof entitlement.starts_at === "string" ? entitlement.starts_at : rawStart;
  const startsAt = new Date(startsAtRaw);
  const finalEnd = new Date(typeof entitlement.expires_at === "string" ? entitlement.expires_at : rawEnd);
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(finalEnd.getTime())) return { start: rawStart, end: rawEnd };
  const now = new Date();
  let cycleStart = startsAt;
  for (let cycle = 0; cycle < 12; cycle += 1) {
    const nextMonth = addUtcMonthsClamped(startsAt, cycle + 1);
    const cycleEnd = nextMonth.getTime() < finalEnd.getTime() ? nextMonth : finalEnd;
    if (now.getTime() < cycleEnd.getTime() || cycleEnd.getTime() >= finalEnd.getTime()) return { start: cycleStart.toISOString(), end: cycleEnd.toISOString() };
    cycleStart = cycleEnd;
  }
  return { start: cycleStart.toISOString(), end: finalEnd.toISOString() };
}

async function getAvatarUsageSnapshot(client: ReturnType<typeof getSupabaseClient>, entitlement: Record<string, unknown> | null): Promise<AvatarUsageSnapshot> {
  const telegramUserId = entitlement?.telegram_user_id ? Number(entitlement.telegram_user_id) : null;
  const planId = entitlement?.plan_id as PlanId | undefined;
  const plan = planId && PLANS[planId] ? PLANS[planId] : null;
  const planActive = Boolean(entitlement?.active);
  const avatarAccess = planActive && Boolean(plan?.modes.includes("avatar"));
  const avatarPeriod = entitlement && plan ? resolveAvatarUsagePeriod(entitlement, plan) : { start: null, end: null };
  const periodStart = avatarPeriod.start;
  const periodEnd = avatarPeriod.end;
  const includedAllowance = plan ? plan.avatarMinutesPerMonth * 60 : 0;
  let includedUsed = 0;
  if (telegramUserId && periodStart && periodEnd) {
    const { data: events, error } = await client.from("avatar_usage_events").select("included_seconds_charged").eq("telegram_user_id", telegramUserId).eq("period_start", periodStart).eq("period_end", periodEnd);
    if (error) throw error;
    includedUsed = (events || []).reduce((sum: number, row: Record<string, unknown>) => sum + Number(row.included_seconds_charged || 0), 0);
  }
  let addonPurchased = 0;
  let addonUsed = 0;
  if (telegramUserId) {
    const { data: balance, error } = await client.from("avatar_addon_balances").select("purchased_seconds, used_seconds").eq("telegram_user_id", telegramUserId).maybeSingle();
    if (error) throw error;
    addonPurchased = Number(balance?.purchased_seconds || 0);
    addonUsed = Number(balance?.used_seconds || 0);
  }
  const includedRemaining = Math.max(includedAllowance - includedUsed, 0);
  const addonRemaining = Math.max(addonPurchased - addonUsed, 0);
  const availableSeconds = avatarAccess ? includedRemaining + addonRemaining : 0;
  return { plan_active: planActive, avatar_access: avatarAccess, can_create_avatar: avatarAccess && availableSeconds > 0, period_start: periodStart, period_end: periodEnd, included_allowance_seconds: includedAllowance, included_used_seconds: includedUsed, included_remaining_seconds: includedRemaining, addon_purchased_seconds: addonPurchased, addon_used_seconds: addonUsed, addon_remaining_seconds: addonRemaining, addon_locked: !avatarAccess && addonRemaining > 0, available_seconds: availableSeconds };
}

async function recordAvatarUsage(client: ReturnType<typeof getSupabaseClient>, telegramUserId: string, requestIdRaw: unknown, durationRaw: unknown): Promise<{ duplicate: boolean; usage: AvatarUsageSnapshot }> {
  const entitlement = await getInternalEntitlement(client, telegramUserId);
  if (!entitlement || !entitlement.active) throw new Error("avatar_plan_inactive");
  const planId = entitlement.plan_id as PlanId;
  const plan = PLANS[planId];
  if (!plan || !plan.modes.includes("avatar")) throw new Error("avatar_not_in_plan");
  const requestId = typeof requestIdRaw === "string" ? requestIdRaw.trim() : "";
  const durationSeconds = Number(durationRaw);
  if (requestId.length < 8 || requestId.length > 200) throw new Error("invalid_avatar_request_id");
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 600) throw new Error("invalid_avatar_duration");
  const usageBefore = await getAvatarUsageSnapshot(client, entitlement);
  if (!usageBefore.period_start || !usageBefore.period_end) throw new Error("avatar_period_unavailable");
  if (!usageBefore.can_create_avatar || durationSeconds > usageBefore.available_seconds) throw new Error("avatar_quota_exceeded");
  const { data, error } = await client.rpc("record_avatar_usage", { p_telegram_user_id: Number(telegramUserId), p_request_id: requestId, p_duration_seconds: durationSeconds, p_period_start: usageBefore.period_start, p_period_end: usageBefore.period_end, p_included_allowance_seconds: plan.avatarMinutesPerMonth * 60 });
  if (error) { if (String(error.message || "").includes("avatar_quota_exceeded")) throw new Error("avatar_quota_exceeded"); throw error; }
  const row = Array.isArray(data) ? data[0] : data;
  const usage = await getAvatarUsageSnapshot(client, entitlement);
  return { duplicate: Boolean(row?.duplicate), usage };
}

// ---------------------------------------------------------------------------
// Checkout / Stripe
// ---------------------------------------------------------------------------

async function getCheckoutStatus(client: ReturnType<typeof getSupabaseClient>, stripeCheckoutSessionId: string): Promise<Record<string, unknown>> {
  const sessionId = String(stripeCheckoutSessionId || "").trim();
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return { found: false, state: "invalid", payment_status: "invalid" };
  const { data: session, error: sessionError } = await client.from("purchase_sessions").select("telegram_user_id, plan_id, status, stripe_checkout_session_id").eq("stripe_checkout_session_id", sessionId).maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) return { found: false, state: "unknown", payment_status: "unknown", entitlement_status: "waiting", plan: null, access_expires_at: null };
  const plan = PLANS[session.plan_id as PlanId] || null;
  const { data: payment, error: paymentError } = await client.from("payments").select("status, paid_at, stripe_payment_intent_id, stripe_subscription_id").eq("stripe_checkout_session_id", sessionId).maybeSingle();
  if (paymentError) throw paymentError;
  if (!payment || payment.status !== "paid") return { found: true, state: "pending", payment_status: payment ? payment.status : "pending", entitlement_status: "waiting", plan: plan ? { id: plan.id, name: plan.name } : null, access_expires_at: null };
  const { data: entitlement, error: entError } = await client.from("entitlements").select("status, expires_at, plan_id").eq("telegram_user_id", session.telegram_user_id).maybeSingle();
  if (entError) throw entError;
  const entActive = entitlement && entitlement.status === "active" && new Date(entitlement.expires_at).getTime() > Date.now();
  return { found: true, state: entActive ? "paid" : "processing", payment_status: "paid", entitlement_status: entitlement ? entitlement.status : "processing", plan: plan ? { id: plan.id, name: plan.name } : null, access_expires_at: entitlement ? entitlement.expires_at : null };
}

function buildPriceCatalog(): Record<PlanId, string | null> { return { seven_day: Deno.env.get("STRIPE_PRICE_SEVEN_DAY") || null, monthly: Deno.env.get("STRIPE_PRICE_MONTHLY") || null, yearly: Deno.env.get("STRIPE_PRICE_YEARLY") || null }; }
function assertTestMode(secretKey: string): boolean { if (!secretKey) return false; if (secretKey.startsWith("sk_live_")) throw new Error("STRIPE_SECRET_KEY is a LIVE key. This integration must use TEST mode only."); if (!["sk_test_", "rk_test_"].some((p) => secretKey.startsWith(p))) throw new Error("STRIPE_SECRET_KEY must be a Stripe TEST mode key (sk_test_ or rk_test_)."); return true; }

async function createCheckoutSession(client: ReturnType<typeof getSupabaseClient>, token: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  return createRevolutCheckout({
    token,
    plans: PLANS,
    getEnv: (key: string) => Deno.env.get(key),
    store: {
      find: (tokenHash: string) => findByTokenHash(client, tokenHash),
      claim: async (session: PurchaseSession, patch: Record<string, unknown>, now: string) => {
        const { data, error } = await client.from("purchase_sessions")
          .update(patch).eq("id", session.id).eq("status", "pending")
          .eq("plan_id", session.plan_id).gt("expires_at", now)
          .is("stripe_checkout_session_id", null).select("id").maybeSingle();
        if (error) throw error;
        return data;
      },
    },
  });
}

async function verifyWebhookEvent(rawBody: string, signature: string, webhookSecret: string): Promise<Record<string, unknown>> {
  const timestampMatch = signature.match(/t=(\d+)/); const sigMatch = signature.match(/v1=([a-f0-9]+)/); if (!timestampMatch || !sigMatch) throw new Error("Invalid signature format.");
  const payload = `${timestampMatch[1]}.${rawBody}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expectedSig = Array.from(new Uint8Array(sigBytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!safeEqual(sigMatch[1], expectedSig)) throw new Error("Signature verification failed.");
  return JSON.parse(rawBody);
}

async function handleCheckoutCompleted(client: ReturnType<typeof getSupabaseClient>, session: Record<string, unknown> | undefined, eventId: string): Promise<Record<string, unknown>> {
  if (!session || String(session.payment_status || "") !== "paid") return { action: "ignored" };
  const checkoutSessionId = String(session.id);
  const { data: payment, error } = await client.from("payments").select("*").eq("stripe_checkout_session_id", checkoutSessionId).maybeSingle(); if (error) throw error; if (!payment || payment.status === "paid") return { action: "ignored" };
  const now = new Date().toISOString();
  await client.from("payments").update({ status: "paid", paid_at: now, updated_at: now, last_stripe_event_id: eventId, stripe_payment_intent_id: session.payment_intent || null, stripe_subscription_id: session.subscription || null, stripe_customer_id: session.customer || null }).eq("stripe_checkout_session_id", checkoutSessionId);
  const plan = PLANS[payment.plan_id as PlanId]; const startsAt = new Date(); const expiresAt = new Date(startsAt.getTime() + plan.durationDays * 86400000);
  await client.from("entitlements").upsert({ telegram_user_id: Number(payment.telegram_user_id), plan_id: payment.plan_id, status: "active", billing_status: payment.plan_id === "seven_day" ? "paid" : "active", stripe_customer_id: session.customer || null, stripe_subscription_id: session.subscription || null, source_payment_id: payment.id, starts_at: startsAt.toISOString(), current_period_start: startsAt.toISOString(), current_period_end: expiresAt.toISOString(), expires_at: expiresAt.toISOString(), cancel_at_period_end: false, updated_at: now }, { onConflict: "telegram_user_id" });
  return { action: "entitlement_activated", paymentId: payment.id, telegramUserId: payment.telegram_user_id, planId: payment.plan_id };
}

async function handleCheckoutFailed(client: ReturnType<typeof getSupabaseClient>, session: Record<string, unknown> | undefined, eventId: string, eventType: string): Promise<Record<string, unknown>> {
  if (!session) return { action: "ignored" }; const checkoutSessionId = String(session.id); const { data: payment, error } = await client.from("payments").select("*").eq("stripe_checkout_session_id", checkoutSessionId).maybeSingle(); if (error) throw error; if (!payment) return { action: "ignored" }; const now = new Date().toISOString();
  if (payment.status === "paid" && eventType === "checkout.session.async_payment_failed") { await client.from("payments").update({ status: "failed", failed_at: now, updated_at: now, last_stripe_event_id: eventId }).eq("stripe_checkout_session_id", checkoutSessionId); await client.from("entitlements").update({ status: "cancelled", billing_status: "unpaid", cancel_at_period_end: true, updated_at: now }).eq("telegram_user_id", payment.telegram_user_id).eq("source_payment_id", payment.id); return { action: "payment_failed_entitlement_revoked" }; }
  if (payment.status !== "paid") await client.from("payments").update({ status: "failed", failed_at: now, updated_at: now, last_stripe_event_id: eventId }).eq("stripe_checkout_session_id", checkoutSessionId);
  return { action: "payment_failed" };
}

async function processWebhookEvent(client: ReturnType<typeof getSupabaseClient>, event: Record<string, unknown>): Promise<Record<string, unknown>> { const type = String(event.type); const obj = (event.data as Record<string, unknown>)?.object as Record<string, unknown> | undefined; if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") return handleCheckoutCompleted(client, obj, String(event.id)); if (type === "checkout.session.async_payment_failed" || type === "checkout.session.expired") return handleCheckoutFailed(client, obj, String(event.id), type); return { action: "ignored" }; }
async function handleWebhook(client: ReturnType<typeof getSupabaseClient>, rawBody: string, signature: string): Promise<Response> { const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET"); const stripeKey = Deno.env.get("STRIPE_SECRET_KEY"); if (!secret || !stripeKey) return sendError(503, "webhook_not_configured", "Webhook обработката не е конфигурирана."); let event: Record<string, unknown>; try { event = await verifyWebhookEvent(rawBody, signature, secret); } catch { return sendError(400, "signature_invalid", "Невалидна Stripe подписка."); } const eventId = String(event.id); const now = new Date().toISOString(); const { error: insertError } = await client.from("stripe_events").insert({ event_id: eventId, event_type: String(event.type), object_id: String((event.data as any)?.object?.id || null), livemode: Boolean(event.livemode), status: "processing", attempts: 1, received_at: now, updated_at: now }); if (insertError) return sendJson({ status: 200 }, { received: true, status: "duplicate" }); try { const result = await processWebhookEvent(client, event); await client.from("stripe_events").update({ status: "processed", processed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("event_id", eventId); return sendJson({ status: 200 }, { received: true, status: "processed", ...result }); } catch (err) { await client.from("stripe_events").update({ status: "failed", last_error_code: String((err as Error)?.message || "unknown").slice(0, 200), updated_at: new Date().toISOString() }).eq("event_id", eventId); return sendJson({ status: 500 }, { received: true, status: "failed" }); } }

// ---------------------------------------------------------------------------
// Community helpers
// ---------------------------------------------------------------------------

async function confirmRevolutManualTestPayment(req: Request, client: ReturnType<typeof getSupabaseClient>): Promise<Response> {
  const adminUserId = await getAuthUserId(req, client);
  if (!adminUserId) return sendError(401, "unauthorized", "Влезте като собственик.");
  const profile = await getCommunityProfile(client, adminUserId);
  if (!profile?.is_admin) return sendError(403, "admin_required", "Само собственик може да потвърди плащане.");
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return sendError(400, "invalid_json", "Невалидни данни."); }
  const sessionToken = String(body.session || "").trim();
  const paymentReference = String(body.payment_reference || "").trim();
  if (!TOKEN_RE.test(sessionToken)) return sendError(400, "invalid_session_token", "Невалидна purchase session.");
  if (!/^[A-Za-z0-9._:/#-]{6,160}$/.test(paymentReference)) return sendError(400, "invalid_payment_reference", "Въведете валиден уникален Revolut payment reference.");
  const tokenHash = await hashToken(sessionToken);
  const { data, error } = await client.rpc("confirm_revolut_manual_test_payment", { p_token_hash: tokenHash, p_provider_reference: paymentReference, p_confirmed_by: adminUserId });
  if (error) {
    const code = String(error.message || "manual_confirmation_failed");
    if (code.includes("already")) return sendError(409, "already_confirmed", "Това плащане или purchase session вече е използвано.");
    if (code.includes("expired")) return sendError(410, "session_expired", "Purchase session е изтекла.");
    if (code.includes("eligible")) return sendError(409, "session_not_eligible", "Сесията не е валидна за monthly €1 test.");
    return sendError(400, "manual_confirmation_failed", "Потвърждението не беше записано.");
  }
  return sendJson({ status: 200 }, { confirmed: true, duplicate: Boolean(data?.duplicate), plan_id: data?.plan_id || "monthly", telegram_user_id: data?.telegram_user_id ? String(data.telegram_user_id) : null, entitlement_expires_at: data?.expires_at || null });
}

const POST_MAX_LENGTH = 500; const POST_MIN_LENGTH = 1; const DISPLAY_NAME_MAX_LENGTH = 50; const DUPLICATE_POST_WINDOW_SECONDS = 30; const FEED_PAGE_SIZE = 20; const MESSAGE_MAX_LENGTH = 2000; const MESSAGE_RATE_LIMIT_SECONDS = 2; const CONVERSATION_PAGE_SIZE = 50;
interface CommunityProfile { user_id: string; telegram_user_id: number | null; display_name: string; is_admin: boolean; bio: string | null; avatar_url: string | null; }
async function getAuthUserId(req: Request, client: ReturnType<typeof getSupabaseClient>): Promise<string | null> { const authHeader = req.headers.get("authorization") || ""; if (!authHeader.startsWith("Bearer ")) return null; const token = authHeader.slice(7).trim(); if (!token || token.length < 10) return null; try { const { data, error } = await client.auth.getUser(token); if (error || !data.user?.id) return null; return data.user.id; } catch { return null; } }
async function getCommunityProfile(client: ReturnType<typeof getSupabaseClient>, userId: string): Promise<CommunityProfile | null> { const { data, error } = await client.from("community_profiles").select("user_id, telegram_user_id, display_name, is_admin, bio, avatar_url").eq("user_id", userId).maybeSingle(); if (error) throw error; return data as CommunityProfile | null; }
interface EntitlementInfo { active: boolean; status: string; plan_id: string; is_admin: boolean; }
async function getCommunityEntitlement(client: ReturnType<typeof getSupabaseClient>, profile: CommunityProfile): Promise<EntitlementInfo> { if (profile.is_admin) return { active: true, status: "active", plan_id: "admin", is_admin: true }; if (!profile.telegram_user_id) return { active: false, status: "none", plan_id: "none", is_admin: false }; const { data, error } = await client.from("entitlements").select("status, plan_id, expires_at").eq("telegram_user_id", profile.telegram_user_id).maybeSingle(); if (error) throw error; if (!data) return { active: false, status: "none", plan_id: "none", is_admin: false }; return { active: data.status === "active" && new Date(data.expires_at).getTime() > Date.now(), status: data.status, plan_id: data.plan_id, is_admin: false }; }
function canWrite(e: EntitlementInfo): boolean { return e.active || e.is_admin; }
function validatePostContent(raw: unknown): string | null { if (typeof raw !== "string") return null; const t = raw.trim(); return t.length >= POST_MIN_LENGTH && t.length <= POST_MAX_LENGTH ? t : null; }
function validateDisplayName(raw: unknown): string | null { if (typeof raw !== "string") return null; const t = raw.trim(); return t.length >= 1 && t.length <= DISPLAY_NAME_MAX_LENGTH ? t : null; }
function validateMessageText(raw: unknown): string | null { if (typeof raw !== "string") return null; const t = raw.trim(); return t.length >= 1 && t.length <= MESSAGE_MAX_LENGTH ? t : null; }
async function isBlocked(client: ReturnType<typeof getSupabaseClient>, blockerId: string, blockedId: string): Promise<boolean> { const { data } = await client.from("community_blocks").select("blocker_id").eq("blocker_id", blockerId).eq("blocked_id", blockedId).maybeSingle(); return !!data; }
async function verifyConversationMembership(client: ReturnType<typeof getSupabaseClient>, conversationId: string, userId: string): Promise<boolean> { const { data } = await client.from("private_conversation_members").select("conversation_id").eq("conversation_id", conversationId).eq("user_id", userId).maybeSingle(); return !!data; }
async function getOrCreateConversation(client: ReturnType<typeof getSupabaseClient>, userA: string, userB: string): Promise<string> { const lesser = userA < userB ? userA : userB; const greater = userA < userB ? userB : userA; const { data: existing } = await client.from("private_conversations").select("id").eq("user_a", lesser).eq("user_b", greater).maybeSingle(); if (existing) return existing.id as string; const convId = crypto.randomUUID(); const now = new Date().toISOString(); await client.from("private_conversations").insert({ id: convId, user_a: lesser, user_b: greater, created_at: now }); await client.from("private_conversation_members").insert([{ conversation_id: convId, user_id: userA, created_at: now }, { conversation_id: convId, user_id: userB, created_at: now }]); return convId; }

async function handleGetProfile(req: Request, client: ReturnType<typeof getSupabaseClient>): Promise<Response> { const userId = await getAuthUserId(req, client); if (!userId) return sendError(401, "unauthorized", "Влезте в профила си."); const profile = await getCommunityProfile(client, userId); if (!profile) return sendJson({ status: 200 }, { has_profile: false }); const entitlement = await getCommunityEntitlement(client, profile); const internalEntitlement = profile.telegram_user_id ? await getInternalEntitlement(client, String(profile.telegram_user_id)) : null; return sendJson({ status: 200 }, { has_profile: true, display_name: profile.display_name, bio: profile.bio, avatar_url: profile.avatar_url, is_admin: profile.is_admin, telegram_linked: profile.telegram_user_id !== null, can_post: canWrite(entitlement), entitlement: { active: entitlement.active, status: entitlement.status, plan_id: entitlement.plan_id, plan_name: internalEntitlement?.plan ? (internalEntitlement.plan as Record<string, unknown>).name : null, billing_status: internalEntitlement?.billing_status || null, current_period_start: internalEntitlement?.current_period_start || null, current_period_end: internalEntitlement?.current_period_end || null, expires_at: internalEntitlement?.expires_at || null, cancel_at_period_end: Boolean(internalEntitlement?.cancel_at_period_end) }, avatar_usage: await getAvatarUsageSnapshot(client, internalEntitlement) }); }
async function handleCommunityStatus(req: Request, client: ReturnType<typeof getSupabaseClient>): Promise<Response> { const userId = await getAuthUserId(req, client); if (!userId) return sendJson({ status: 200 }, { authenticated: false, has_profile: false, can_post: false, entitlement: null }); const profile = await getCommunityProfile(client, userId); if (!profile) return sendJson({ status: 200 }, { authenticated: true, has_profile: false, can_post: false, entitlement: null }); const e = await getCommunityEntitlement(client, profile); return sendJson({ status: 200 }, { authenticated: true, has_profile: true, display_name: profile.display_name, is_admin: profile.is_admin, can_post: canWrite(e), entitlement: { active: e.active, status: e.status, plan_id: e.plan_id } }); }
async function handleUpsertProfile(req: Request, client: ReturnType<typeof getSupabaseClient>): Promise<Response> { const userId = await getAuthUserId(req, client); if (!userId) return sendError(401, "unauthorized", "Влезте в профила си."); const body = await req.json(); const displayName = validateDisplayName(body.display_name); if (!displayName) return sendError(400, "invalid_display_name", "Името трябва да бъде между 1 и 50 символа."); let telegramUserId: number | null = null; if (body.telegram_user_id != null) { const n = normalizeTelegramUserId(body.telegram_user_id); if (!n) return sendError(400, "invalid_telegram_user", "Невалиден Telegram user ID."); telegramUserId = Number(n); } const existing = await getCommunityProfile(client, userId); const now = new Date().toISOString(); if (existing) { const update: Record<string, unknown> = { display_name: displayName, updated_at: now }; if (telegramUserId !== null) update.telegram_user_id = telegramUserId; const { error } = await client.from("community_profiles").update(update).eq("user_id", userId); if (error) return sendError(503, "database_error", "Грешка при обновяване на профила."); return handleGetProfile(req, client); } const { error } = await client.from("community_profiles").insert({ user_id: userId, display_name: displayName, telegram_user_id: telegramUserId, is_admin: false, created_at: now, updated_at: now }); if (error) return sendError(503, "database_error", "Грешка при създаване на профила."); return handleGetProfile(req, client); }

async function handleListPosts(req: Request, client: ReturnType<typeof getSupabaseClient>): Promise<Response> { const userId = await getAuthUserId(req, client); if (!userId) return sendError(401, "unauthorized", "Влезте в профила си."); const profile = await getCommunityProfile(client, userId); if (!profile) return sendError(403, "no_profile", "Създайте профил първо."); const { data, error } = await client.from("community_posts").select("id,user_id,content,created_at,community_profiles!inner(display_name)").is("deleted_at", null).order("created_at", { ascending: false }).limit(FEED_PAGE_SIZE); if (error) return sendError(503, "database_error", "Грешка при зареждане на публикациите."); const posts = (data || []).map((p: any) => ({ id: p.id, author_name: p.community_profiles?.display_name || "Анонимен", author_is_me: p.user_id === userId, content: p.content, created_at: p.created_at, reactions: 0, my_reaction: false })); return sendJson({ status: 200 }, { posts, has_more: false }); }
async function handleCreatePost(req: Request, client: ReturnType<typeof getSupabaseClient>): Promise<Response> { const userId = await getAuthUserId(req, client); if (!userId) return sendError(401, "unauthorized", "Влезте в профила си."); const profile = await getCommunityProfile(client, userId); if (!profile) return sendError(403, "no_profile", "Създайте профил първо."); const e = await getCommunityEntitlement(client, profile); if (!canWrite(e)) return sendError(403, "access_denied", "Community е достъпна само с активен платен план."); const body = await req.json(); const content = validatePostContent(body.content); if (!content) return sendError(400, "invalid_content", "Текстът трябва да бъде между 1 и 500 символа."); const now = new Date().toISOString(); const { data, error } = await client.from("community_posts").insert({ id: crypto.randomUUID(), user_id: userId, content, created_at: now, updated_at: now }).select("id,content,created_at").maybeSingle(); if (error) return sendError(503, "database_error", "Грешка при създаване на публикацията."); return sendJson({ status: 201 }, { post: { id: data.id, author_name: profile.display_name, author_is_me: true, content: data.content, created_at: data.created_at, reactions: 0, my_reaction: false } }); }
async function handleDeletePost(req: Request, client: ReturnType<typeof getSupabaseClient>, postId: string): Promise<Response> { const userId = await getAuthUserId(req, client); if (!userId) return sendError(401, "unauthorized", "Влезте в профила си."); const profile = await getCommunityProfile(client, userId); if (!profile) return sendError(403, "no_profile", "Създайте профил първо."); const { data: post } = await client.from("community_posts").select("user_id,deleted_at").eq("id", postId).maybeSingle(); if (!post || post.deleted_at) return sendError(404, "post_not_found", "Публикацията не е намерена."); if (post.user_id !== userId && !profile.is_admin) return sendError(403, "forbidden", "Можеш да изтриваш само свои публикации."); const now = new Date().toISOString(); const { error } = await client.from("community_posts").update({ deleted_at: now, updated_at: now }).eq("id", postId); if (error) return sendError(503, "database_error", "Грешка при изтриване на публикацията."); return sendJson({ status: 200 }, { deleted: true }); }
async function handleToggleReaction(req: Request, client: ReturnType<typeof getSupabaseClient>, postId: string): Promise<Response> { const userId = await getAuthUserId(req, client); if (!userId) return sendError(401, "unauthorized", "Влезте в профила си."); const profile = await getCommunityProfile(client, userId); if (!profile) return sendError(403, "no_profile", "Създайте профил първо."); const e = await getCommunityEntitlement(client, profile); if (!canWrite(e)) return sendError(403, "access_denied", "Реакциите са достъпни само с активен платен план."); const { data: existing } = await client.from("community_reactions").select("post_id").eq("post_id", postId).eq("user_id", userId).maybeSingle(); if (existing) { await client.from("community_reactions").delete().eq("post_id", postId).eq("user_id", userId); return sendJson({ status: 200 }, { my_reaction: false }); } await client.from("community_reactions").insert({ post_id: postId, user_id: userId, created_at: new Date().toISOString() }); return sendJson({ status: 200 }, { my_reaction: true }); }

async function handleViewMember(req: Request, client: ReturnType<typeof getSupabaseClient>, targetUserId: string): Promise<Response> { const userId = await getAuthUserId(req, client); if (!userId) return sendError(401, "unauthorized", "Влезте в профила си."); const { data: target, error } = await client.from("community_profiles").select("user_id,display_name,bio,avatar_url,created_at").eq("user_id", targetUserId).maybeSingle(); if (error || !target) return sendError(404, "member_not_found", "Потребителят не е намерен."); const blockedByMe = await isBlocked(client, userId, targetUserId); const { count } = await client.from("community_posts").select("*", { count: "exact", head: true }).eq("user_id", targetUserId).is("deleted_at", null); return sendJson({ status: 200 }, { user_id: target.user_id, display_name: target.display_name, bio: target.bio || "", avatar_url: target.avatar_url || null, post_count: count || 0, is_me: targetUserId === userId, blocked_by_me: blockedByMe }); }
async function handleCreateConversation(req: Request, client: ReturnType<typeof getSupabaseClient>): Promise<Response> { const userId = await getAuthUserId(req, client); if (!userId) return sendError(401, "unauthorized", "Влезте в профила си."); const body = await req.json(); const targetUserId = String(body.target_user_id || "").trim(); if (!targetUserId || targetUserId === userId) return sendError(400, "invalid_user_id", "Невалиден потребителски ID."); if (await isBlocked(client, targetUserId, userId) || await isBlocked(client, userId, targetUserId)) return sendError(403, "blocked", "Съобщенията са блокирани."); const { data: target } = await client.from("community_profiles").select("display_name,avatar_url").eq("user_id", targetUserId).maybeSingle(); if (!target) return sendError(404, "member_not_found", "Потребителят не е намерен."); const convId = await getOrCreateConversation(client, userId, targetUserId); return sendJson({ status: 200 }, { conversation_id: convId, other_user_id: targetUserId, other_display_name: target.display_name, other_avatar_url: target.avatar_url || null }); }
async function handleListConversations(req: Request, client: ReturnType<typeof getSupabaseClient>): Promise<Response> { const userId = await getAuthUserId(req, client); if (!userId) return sendError(401, "unauthorized", "Влезте в профила си."); const { data: memberships, error } = await client.from("private_conversation_members").select("conversation_id,last_read_at,muted,created_at").eq("user_id", userId).order("created_at", { ascending: false }); if (error) return sendError(503, "database_error", "Грешка при зареждане на съобщенията."); if (!memberships?.length) return sendJson({ status: 200 }, { conversations: [] }); const ids = memberships.map((m:any)=>m.conversation_id); const { data: convs } = await client.from("private_conversations").select("id,user_a,user_b,created_at").in("id", ids); const result=[]; for (const conv of convs||[]) { const other=conv.user_a===userId?conv.user_b:conv.user_a; const { data:p }=await client.from("community_profiles").select("display_name,avatar_url").eq("user_id",other).maybeSingle(); const { data:last }=await client.from("private_messages").select("type,text_content,created_at").eq("conversation_id",conv.id).order("created_at",{ascending:false}).limit(1).maybeSingle(); result.push({id:conv.id,other_user_id:other,other_display_name:p?.display_name||"Анонимен",other_avatar_url:p?.avatar_url||null,last_message_preview:last?.type==="text"?last.text_content:(last?"🎙 Гласово съобщение":""),last_message_type:last?.type||null,last_message_at:last?.created_at||conv.created_at,unread_count:0,muted:memberships.find((m:any)=>m.conversation_id===conv.id)?.muted||false}); } return sendJson({status:200},{conversations:result}); }
async function handleListMessages(req: Request, client: ReturnType<typeof getSupabaseClient>, conversationId: string): Promise<Response> { const userId=await getAuthUserId(req,client); if(!userId)return sendError(401,"unauthorized","Влезте в профила си."); if(!await verifyConversationMembership(client,conversationId,userId))return sendError(403,"forbidden","Нямаш достъп до този разговор."); const {data,error}=await client.from("private_messages").select("id,conversation_id,sender_id,type,text_content,voice_storage_path,voice_duration_ms,voice_mime_type,voice_size_bytes,created_at").eq("conversation_id",conversationId).order("created_at",{ascending:false}).limit(CONVERSATION_PAGE_SIZE); if(error)return sendError(503,"database_error","Грешка при зареждане на съобщенията."); return sendJson({status:200},{messages:(data||[]).map((m:any)=>({...m,is_me:m.sender_id===userId})),has_more:false}); }
async function handleSendMessage(req: Request, client: ReturnType<typeof getSupabaseClient>, conversationId: string): Promise<Response> { const userId=await getAuthUserId(req,client); if(!userId)return sendError(401,"unauthorized","Влезте в профила си."); const profile=await getCommunityProfile(client,userId); if(!profile)return sendError(403,"no_profile","Създайте профил първо."); if(!canWrite(await getCommunityEntitlement(client,profile)))return sendError(403,"access_denied","Частните съобщения изискват активен платен план."); if(!await verifyConversationMembership(client,conversationId,userId))return sendError(403,"forbidden","Нямаш достъп до този разговор."); const body=await req.json(); const content=validateMessageText(body.content); if(!content)return sendError(400,"invalid_content","Съобщението трябва да бъде между 1 и 2000 символа."); const now=new Date().toISOString(); const {data,error}=await client.from("private_messages").insert({id:crypto.randomUUID(),conversation_id:conversationId,sender_id:userId,type:"text",text_content:content,created_at:now}).select("id,created_at").maybeSingle(); if(error)return sendError(503,"database_error","Грешка при изпращане на съобщението."); return sendJson({status:201},{message:{id:data.id,conversation_id:conversationId,sender_id:userId,is_me:true,type:"text",text_content:content,created_at:data.created_at}}); }
async function handleMarkRead(req: Request, client: ReturnType<typeof getSupabaseClient>, conversationId: string): Promise<Response> { const userId=await getAuthUserId(req,client); if(!userId)return sendError(401,"unauthorized","Влезте в профила си."); if(!await verifyConversationMembership(client,conversationId,userId))return sendError(403,"forbidden","Нямаш достъп до този разговор."); await client.from("private_conversation_members").update({last_read_at:new Date().toISOString()}).eq("conversation_id",conversationId).eq("user_id",userId); return sendJson({status:200},{marked_read:true}); }
async function handleToggleMute(req: Request, client: ReturnType<typeof getSupabaseClient>, conversationId: string): Promise<Response> { const userId=await getAuthUserId(req,client); if(!userId)return sendError(401,"unauthorized","Влезте в профила си."); const {data}=await client.from("private_conversation_members").select("muted").eq("conversation_id",conversationId).eq("user_id",userId).maybeSingle(); if(!data)return sendError(403,"forbidden","Нямаш достъп до този разговор."); const muted=!data.muted; await client.from("private_conversation_members").update({muted}).eq("conversation_id",conversationId).eq("user_id",userId); return sendJson({status:200},{muted}); }
async function handleBlock(req: Request, client: ReturnType<typeof getSupabaseClient>): Promise<Response> { const userId=await getAuthUserId(req,client); if(!userId)return sendError(401,"unauthorized","Влезте в профила си."); const body=await req.json(); const target=String(body.target_user_id||"").trim(); if(!target||target===userId)return sendError(400,"invalid_user_id","Невалиден потребителски ID."); await client.from("community_blocks").upsert({blocker_id:userId,blocked_id:target,created_at:new Date().toISOString()},{onConflict:"blocker_id,blocked_id"}); return sendJson({status:200},{blocked:true}); }
async function handleUnblock(req: Request, client: ReturnType<typeof getSupabaseClient>, target:string):Promise<Response>{const userId=await getAuthUserId(req,client);if(!userId)return sendError(401,"unauthorized","Влезте в профила си.");await client.from("community_blocks").delete().eq("blocker_id",userId).eq("blocked_id",target);return sendJson({status:200},{blocked:false});}
async function handleReport(req: Request, client: ReturnType<typeof getSupabaseClient>):Promise<Response>{const userId=await getAuthUserId(req,client);if(!userId)return sendError(401,"unauthorized","Влезте в профила си.");const body=await req.json();const reason=validateMessageText(body.reason);if(!reason)return sendError(400,"invalid_reason","Невалидна причина.");await client.from("community_reports").insert({id:crypto.randomUUID(),reporter_id:userId,reported_user_id:body.reported_user_id||null,reported_message_id:body.reported_message_id||null,reason,created_at:new Date().toISOString()});return sendJson({status:201},{reported:true});}

async function handleCommunityRequest(req: Request, client: ReturnType<typeof getSupabaseClient>, method: string, segments: string[]):Promise<Response>{
  if(segments.length===3&&segments[2]==="status"&&method==="GET")return handleCommunityStatus(req,client);
  if(segments.length===3&&segments[2]==="profile"&&method==="GET")return handleGetProfile(req,client);
  if(segments.length===3&&segments[2]==="profile"&&method==="POST")return handleUpsertProfile(req,client);
  if(segments.length===3&&segments[2]==="posts"&&method==="GET")return handleListPosts(req,client);
  if(segments.length===3&&segments[2]==="posts"&&method==="POST")return handleCreatePost(req,client);
  if(segments.length===4&&segments[2]==="posts"&&method==="DELETE")return handleDeletePost(req,client,segments[3]);
  if(segments.length===5&&segments[2]==="posts"&&segments[4]==="reactions"&&method==="POST")return handleToggleReaction(req,client,segments[3]);
  if(segments.length===4&&segments[2]==="members"&&method==="GET")return handleViewMember(req,client,segments[3]);
  if(segments.length===3&&segments[2]==="conversations"&&method==="GET")return handleListConversations(req,client);
  if(segments.length===3&&segments[2]==="conversations"&&method==="POST")return handleCreateConversation(req,client);
  if(segments.length===5&&segments[2]==="conversations"&&segments[4]==="messages"&&method==="GET")return handleListMessages(req,client,segments[3]);
  if(segments.length===5&&segments[2]==="conversations"&&segments[4]==="messages"&&method==="POST")return handleSendMessage(req,client,segments[3]);
  if(segments.length===5&&segments[2]==="conversations"&&segments[4]==="read"&&method==="POST")return handleMarkRead(req,client,segments[3]);
  if(segments.length===5&&segments[2]==="conversations"&&segments[4]==="mute"&&method==="POST")return handleToggleMute(req,client,segments[3]);
  if(segments.length===3&&segments[2]==="blocks"&&method==="POST")return handleBlock(req,client);
  if(segments.length===4&&segments[2]==="blocks"&&method==="DELETE")return handleUnblock(req,client,segments[3]);
  if(segments.length===3&&segments[2]==="reports"&&method==="POST")return handleReport(req,client);
  return sendError(404,"not_found","Неизвестен маршрут.");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const { segments } = parseUrl(req.url || "/"); const method = (req.method || "GET").toUpperCase(); if (segments[0] !== "api" || segments.length < 2) return sendError(404, "not_found", "Неизвестен маршрут."); const client = getSupabaseClient();
    if (segments[1] === "ready" && method === "GET" && segments.length === 2) { try { const { error } = await client.from("purchase_sessions").select("id").limit(1); return sendJson({ status: 200 }, { ok: !error }); } catch { return sendJson({ status: 200 }, { ok: false }); } }
    if (segments[1] === "webhooks" && segments.length === 3 && segments[2] === "stripe" && method === "POST") return handleWebhook(client, await req.text(), req.headers.get("stripe-signature") || "");
    if (segments[1] === "purchase-sessions") { if (segments.length === 2 && method === "GET") return sendError(405,"method_not_allowed","Използвай POST за създаване."); if (segments.length === 2 && method === "POST") { const secret=getInternalSecret(); const token=getBearerToken(req); if(!token||!safeEqual(token,secret))return sendError(401,"unauthorized","Невалидна авторизация."); const body=await req.json(); const r=await createPurchaseSessionService(client,{telegramUserId:body.telegram_user_id,planId:body.plan_id,appBaseUrl:getAppBaseUrl(req)}); return sendJson({status:r.status},r.body); } if(segments.length===3&&method==="GET"){const r=await verifySessionService(client,segments[2]);return sendJson({status:r.status},r.body);} if(segments.length===4&&segments[3]==="checkout"&&method==="POST"){const r=await createCheckoutSession(client,segments[2]);return sendJson({status:r.status},r.body);} }
    if(segments[1]==="checkout-sessions"&&segments.length===4&&segments[3]==="status"&&method==="GET"){const status=await getCheckoutStatus(client,segments[2]);return sendJson({status:200},status);}
    if (segments[1] === "internal" && segments.length === 3 &&
        segments[2] === "checkout-config-status" && method === "GET") {
      const secret = getInternalSecret();
      const token = getBearerToken(req);
      if (!token || !safeEqual(token, secret)) return sendError(401, "unauthorized", "Невалидна авторизация.");
      const status = await inspectTestCheckoutConfiguration({
        getEnv: (key: string) => Deno.env.get(key),
        plans: PLANS,
      });
      return sendJson({ status: 200 }, status);
    }

    if (segments[1] === "admin" && segments.length === 4 && segments[2] === "revolut" && segments[3] === "manual-confirm" && method === "POST") return confirmRevolutManualTestPayment(req, client);
    if (segments[1] === "internal" && segments.length >= 3) { const secret=getInternalSecret(); const token=getBearerToken(req); if(!token||!safeEqual(token,secret))return sendError(401,"unauthorized","Невалидна авторизация."); if(segments[2]==="purchase-sessions"&&segments.length===3&&method==="POST"){const body=await req.json();const r=await createPurchaseSessionService(client,{telegramUserId:body.telegram_user_id,planId:body.plan_id,appBaseUrl:getAppBaseUrl(req)});return sendJson({status:r.status},r.body);} if(segments[2]==="entitlements"&&segments.length===4&&method==="GET"){const id=normalizeTelegramUserId(segments[3]);if(!id)return sendError(400,"invalid_telegram_user","Невалиден Telegram user ID.");const entitlement=await getInternalEntitlement(client,id);return sendJson({status:200},{checked_at:new Date().toISOString(),entitlement});} if(segments[2]==="avatar-usage"&&segments.length===4&&method==="GET"){const id=normalizeTelegramUserId(segments[3]);if(!id)return sendError(400,"invalid_telegram_user","Невалиден Telegram user ID.");const entitlement=await getInternalEntitlement(client,id);return sendJson({status:200},{checked_at:new Date().toISOString(),entitlement_active:Boolean(entitlement?.active),plan_id:entitlement?.plan_id||null,expires_at:entitlement?.expires_at||null,usage:await getAvatarUsageSnapshot(client,entitlement)});} if(segments[2]==="avatar-usage"&&segments.length===4&&method==="POST"){const id=normalizeTelegramUserId(segments[3]);if(!id)return sendError(400,"invalid_telegram_user","Невалиден Telegram user ID.");const body=await req.json();try{const r=await recordAvatarUsage(client,id,body.request_id,body.duration_seconds);return sendJson({status:200},{recorded:!r.duplicate,duplicate:r.duplicate,usage:r.usage});}catch(error){const code=error instanceof Error?error.message:"avatar_usage_failed";if(code==="avatar_plan_inactive"||code==="avatar_not_in_plan")return sendError(403,code,"Avatar режимът изисква активен месечен или годишен план.");if(code==="avatar_quota_exceeded")return sendError(403,code,"Нямате достатъчно оставащо Avatar време.");if(code.startsWith("invalid_avatar_"))return sendError(400,code,"Невалидни данни за Avatar използване.");throw error;}} }
    if (segments[1] === "community") return handleCommunityRequest(req, client, method, segments);
    return sendError(404,"not_found","Неизвестен маршрут.");
  } catch (error) { console.error("API handler error:", error); return sendError(500,"internal_error","Вътрешна грешка."); }
});
