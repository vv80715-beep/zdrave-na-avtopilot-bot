import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createRevolutCheckout, inspectTestCheckoutConfiguration } from "../_shared/revolut-checkout.mjs";
import { deliverAvatarAddonNotification } from "../_shared/avatar-addon-aftercare.mjs";

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
    price: { amount: 1, currency: "EUR", display: "€1" },
    durationDays: 7,
    modes: ["text", "voice", "community"],
    avatarMinutesPerMonth: 0,
  },
  monthly: {
    id: "monthly",
    name: "1 месец с Ели",
    price: { amount: 1, currency: "EUR", display: "€1" },
    durationDays: 30,
    modes: ["text", "voice", "avatar", "community"],
    avatarMinutesPerMonth: 30,
  },
  yearly: {
    id: "yearly",
    name: "1 година с Ели",
    price: { amount: 1, currency: "EUR", display: "€1" },
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
// Avatar add-on Checkout (separate from plan/subscription checkout)
// ---------------------------------------------------------------------------

const AVATAR_ADDON_TEST_AMOUNT_CENTS = 50;
const AVATAR_ADDON_PACKAGES = Object.freeze({
  20: { id: "addon_20", minutes: 20, seconds: 1200 },
  50: { id: "addon_50", minutes: 50, seconds: 3000 },
  100: { id: "addon_100", minutes: 100, seconds: 6000 },
  200: { id: "addon_200", minutes: 200, seconds: 12000 },
} as const);

function getAvatarAddonPackage(raw: unknown): { id: string; minutes: number; seconds: number } | null {
  const minutes = Number(raw);
  if (!Number.isInteger(minutes)) return null;
  return (AVATAR_ADDON_PACKAGES as Record<number, { id: string; minutes: number; seconds: number }>)[minutes] || null;
}

async function createAvatarAddonCheckout(
  req: Request,
  client: ReturnType<typeof getSupabaseClient>,
): Promise<Response> {
  const userId = await getAuthUserId(req, client);
  if (!userId) return sendError(401, "unauthorized", "Влезте в профила си.");

  const profile = await getCommunityProfile(client, userId);
  if (!profile) return sendError(409, "profile_required", "Профилът не е намерен.");

  const effectiveTelegramUserId = await resolveEffectiveTelegramUserId(client, profile);
  if (!effectiveTelegramUserId) {
    return sendError(409, "telegram_not_linked", "Профилът трябва да е свързан с Telegram.");
  }

  const entitlement = await getCommunityEntitlement(client, profile);
  const eligible = entitlement.is_admin || (entitlement.active && ["monthly", "yearly"].includes(entitlement.plan_id));
  if (!eligible) {
    return sendError(403, "avatar_addon_plan_required", "Допълнителните Avatar минути изискват активен месечен или годишен план.");
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {
    return sendError(400, "invalid_json", "Невалидни данни.");
  }
  const pkg = getAvatarAddonPackage(body.minutes);
  if (!pkg) return sendError(400, "invalid_addon_package", "Невалиден пакет.");

  const purchaseId = crypto.randomUUID();
  const now = new Date().toISOString();
  const { error: insertError } = await client.from("avatar_addon_purchases").insert({
    id: purchaseId,
    user_id: userId,
    telegram_user_id: effectiveTelegramUserId,
    package_id: pkg.id,
    minutes: pkg.minutes,
    seconds: pkg.seconds,
    amount_cents: AVATAR_ADDON_TEST_AMOUNT_CENTS,
    currency: "eur",
    status: "pending",
    created_at: now,
    updated_at: now,
  });
  if (insertError) throw insertError;

  const appBaseUrl = getAppBaseUrl();
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("line_items[0][price_data][currency]", "eur");
  params.set("line_items[0][price_data][unit_amount]", String(AVATAR_ADDON_TEST_AMOUNT_CENTS));
  params.set("line_items[0][price_data][product_data][name]", "Eli Avatar +" + pkg.minutes + " минути");
  params.set("line_items[0][price_data][product_data][description]", "Тестова цена: €0.50");
  params.set("line_items[0][quantity]", "1");
  params.set("success_url", appBaseUrl + "/profile.html?addon_payment=success&addon_session_id={CHECKOUT_SESSION_ID}");
  params.set("cancel_url", appBaseUrl + "/profile.html?addon_payment=cancelled");
  params.set("client_reference_id", purchaseId);
  params.set("metadata[purchase_kind]", "avatar_addon");
  params.set("metadata[addon_purchase_id]", purchaseId);
  params.set("metadata[addon_minutes]", String(pkg.minutes));
  params.set("metadata[telegram_user_id]", String(effectiveTelegramUserId));
  params.set("metadata[user_id]", userId);
  params.set("payment_intent_data[metadata][purchase_kind]", "avatar_addon");
  params.set("payment_intent_data[metadata][addon_purchase_id]", purchaseId);
  params.set("payment_intent_data[metadata][addon_minutes]", String(pkg.minutes));
  params.set("payment_intent_data[metadata][telegram_user_id]", String(effectiveTelegramUserId));

  try {
    const stripeSession = await stripeRequest("/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "Idempotency-Key": "avatar_addon_" + purchaseId,
      },
      body: params.toString(),
    });
    const checkoutId = String(stripeSession.id || "");
    const checkoutUrl = typeof stripeSession.url === "string" ? stripeSession.url : "";
    if (!checkoutId || !checkoutUrl) throw new Error("stripe_invalid_checkout_response");

    const { error: updateError } = await client.from("avatar_addon_purchases").update({
      status: "checkout_created",
      stripe_checkout_session_id: checkoutId,
      updated_at: new Date().toISOString(),
    }).eq("id", purchaseId);
    if (updateError) throw updateError;

    return sendJson({ status: 200 }, {
      checkout_url: checkoutUrl,
      checkout_session_id: checkoutId,
      package: { minutes: pkg.minutes, seconds: pkg.seconds },
      test_amount: { amount_cents: AVATAR_ADDON_TEST_AMOUNT_CENTS, currency: "eur" },
    });
  } catch (error) {
    await client.from("avatar_addon_purchases").update({
      status: "failed",
      updated_at: new Date().toISOString(),
    }).eq("id", purchaseId);
    console.error("Avatar add-on checkout create failed:", String((error as Error)?.message || error).slice(0, 180));
    return sendError(503, "avatar_addon_checkout_failed", "Checkout не можа да бъде създаден.");
  }
}

async function getAvatarAddonCheckoutStatus(
  req: Request,
  client: ReturnType<typeof getSupabaseClient>,
  checkoutSessionId: string,
): Promise<Response> {
  const userId = await getAuthUserId(req, client);
  if (!userId) return sendError(401, "unauthorized", "Влезте в профила си.");
  if (!/^cs_[A-Za-z0-9_]+$/.test(checkoutSessionId)) {
    return sendError(400, "invalid_checkout_session", "Невалидна Checkout сесия.");
  }

  const { data, error } = await client.from("avatar_addon_purchases")
    .select("status,minutes,seconds,amount_cents,currency,paid_at")
    .eq("stripe_checkout_session_id", checkoutSessionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return sendError(404, "addon_purchase_not_found", "Покупката не е намерена.");

  return sendJson({ status: 200 }, {
    found: true,
    status: data.status,
    minutes: data.minutes,
    seconds: data.seconds,
    amount_cents: data.amount_cents,
    currency: data.currency,
    paid_at: data.paid_at,
  });
}

function isAvatarAddonSession(session: Record<string, unknown> | undefined): boolean {
  const metadata = session?.metadata as Record<string, unknown> | undefined;
  return String(metadata?.purchase_kind || "") === "avatar_addon";
}

async function handleAvatarAddonCheckoutCompleted(
  client: ReturnType<typeof getSupabaseClient>,
  session: Record<string, unknown> | undefined,
  eventId: string,
): Promise<Record<string, unknown>> {
  if (!session || !isAvatarAddonSession(session)) return { action: "ignored", reason: "not_avatar_addon" };
  if (String(session.payment_status || "") !== "paid") return { action: "ignored", reason: "payment_not_settled" };

  const metadata = session.metadata as Record<string, unknown>;
  const purchaseId = String(metadata.addon_purchase_id || "");
  const checkoutSessionId = String(session.id || "");
  const amountTotal = Number(session.amount_total || 0);
  const currency = String(session.currency || "").toLowerCase();

  if (!/^[0-9a-f-]{36}$/i.test(purchaseId) || !checkoutSessionId) {
    throw new Error("invalid_avatar_addon_metadata");
  }
  if (amountTotal !== AVATAR_ADDON_TEST_AMOUNT_CENTS || currency !== "eur") {
    throw new Error("avatar_addon_amount_mismatch");
  }

  const { data, error } = await client.rpc("credit_avatar_addon_purchase", {
    p_purchase_id: purchaseId,
    p_checkout_session_id: checkoutSessionId,
    p_payment_intent_id: String(session.payment_intent || ""),
    p_event_id: eventId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;

  // The credit transaction (including its durable notice) has committed.
  // Delivery failure must never invalidate payment or re-credit the purchase.
  const notification = await deliverAvatarAddonNotification(
    client, purchaseId, checkoutSessionId, (name: string) => Deno.env.get(name),
  );

  return {
    action: row?.duplicate ? "avatar_addon_already_credited" : "avatar_addon_credited",
    notification,
    purchaseId,
    telegramUserId: row?.telegram_user_id ? String(row.telegram_user_id) : null,
    creditedSeconds: Number(row?.credited_seconds || 0),
    addonPurchasedSeconds: Number(row?.addon_purchased_seconds || 0),
    addonUsedSeconds: Number(row?.addon_used_seconds || 0),
  };
}

async function handleAvatarAddonCheckoutFailed(
  client: ReturnType<typeof getSupabaseClient>,
  session: Record<string, unknown> | undefined,
  eventId: string,
  eventType: string,
): Promise<Record<string, unknown>> {
  if (!session || !isAvatarAddonSession(session)) return { action: "ignored", reason: "not_avatar_addon" };
  const metadata = session.metadata as Record<string, unknown>;
  const purchaseId = String(metadata.addon_purchase_id || "");
  if (!purchaseId) return { action: "ignored", reason: "missing_addon_purchase_id" };

  const { data: purchase, error } = await client.from("avatar_addon_purchases")
    .select("status").eq("id", purchaseId).maybeSingle();
  if (error) throw error;
  if (!purchase) return { action: "ignored", reason: "addon_purchase_not_found" };
  if (purchase.status === "paid") return { action: "ignored", reason: "already_paid" };

  await client.from("avatar_addon_purchases").update({
    status: eventType === "checkout.session.expired" ? "cancelled" : "failed",
    stripe_event_id: eventId,
    updated_at: new Date().toISOString(),
  }).eq("id", purchaseId);

  return { action: "avatar_addon_payment_failed", purchaseId };
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

  let { data: payment, error: paymentError } = await client.from("payments").select("status, paid_at, stripe_payment_intent_id, stripe_subscription_id").eq("stripe_checkout_session_id", sessionId).maybeSingle();
  if (paymentError) throw paymentError;

  // Safety fallback: if the webhook has not reconciled a LIVE Checkout yet,
  // verify the Checkout Session directly with Stripe server-side and process it idempotently.
  if ((!payment || payment.status !== "paid") && sessionId.startsWith("cs_live_")) {
    try {
      const stripeSession = await stripeRequest("/v1/checkout/sessions/" + encodeURIComponent(sessionId));
      if (String(stripeSession.status || "") === "complete" && String(stripeSession.payment_status || "") === "paid") {
        await handleCheckoutCompleted(client, stripeSession, "reconcile:" + sessionId);
        const refreshed = await client.from("payments").select("status, paid_at, stripe_payment_intent_id, stripe_subscription_id").eq("stripe_checkout_session_id", sessionId).maybeSingle();
        if (refreshed.error) throw refreshed.error;
        payment = refreshed.data;
      }
    } catch (error) {
      console.error("Stripe checkout reconciliation failed:", error);
    }
  }

  if (!payment || payment.status !== "paid") return { found: true, state: "pending", payment_status: payment ? payment.status : "pending", entitlement_status: "waiting", plan: plan ? { id: plan.id, name: plan.name } : null, access_expires_at: null };
  const { data: entitlement, error: entError } = await client.from("entitlements").select("status, expires_at, plan_id").eq("telegram_user_id", session.telegram_user_id).maybeSingle();
  if (entError) throw entError;
  const entActive = entitlement && entitlement.status === "active" && new Date(entitlement.expires_at).getTime() > Date.now();
  return { found: true, state: entActive ? "paid" : "processing", payment_status: "paid", entitlement_status: entitlement ? entitlement.status : "processing", plan: plan ? { id: plan.id, name: plan.name } : null, access_expires_at: entitlement ? entitlement.expires_at : null };
}

const LIVE_STRIPE_PRICES: Record<PlanId, string> = {
  seven_day: "price_1UHmz9PYSKogQeLGEnuQPmKV",
  monthly: "price_1UHmzDPYSKogQeLGeaDx9Cu3",
  yearly: "price_1UHmzFPYSKogQeLGBbbgZVRf",
};

function getLiveStripeSecret(): string {
  const key = Deno.env.get("STRIPE_SECRET_KEY") || "";
  if (!key.startsWith("sk_live_") && !key.startsWith("rk_live_")) {
    throw new Error("STRIPE_SECRET_KEY must be a LIVE Stripe key.");
  }
  return key;
}

async function stripeRequest(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const key = getLiveStripeSecret();
  const response = await fetch("https://api.stripe.com" + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + key,
      ...(init.headers || {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof (payload as any)?.error?.message === "string"
      ? (payload as any).error.message
      : "Stripe request failed.";
    throw new Error("stripe_api_error:" + message.slice(0, 160));
  }
  return payload as Record<string, unknown>;
}

async function createCheckoutSession(client: ReturnType<typeof getSupabaseClient>, token: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const normalized = String(token || "").trim();
  if (!TOKEN_RE.test(normalized)) return errorResult("invalid_session_token", "Невалиден session token.", 400);

  const tokenHash = await hashToken(normalized);
  const session = await findByTokenHash(client, tokenHash);
  if (!session) return errorResult("session_not_found", "Сесията не е намерена.", 404);

  const now = new Date();
  if (!session.expires_at || new Date(session.expires_at).getTime() <= now.getTime()) {
    if (session.status === "pending") await updateSessionStatus(client, tokenHash, "expired");
    return errorResult("session_expired", "Сесията е изтекла.", 410);
  }

  const plan = PLANS[session.plan_id as PlanId];
  if (!plan) return errorResult("invalid_plan", "Невалиден план.", 400);

  if (session.status === "paid" || session.status === "cancelled" || session.status === "expired") {
    return errorResult("session_consumed", "Сесията вече не е достъпна за плащане.", 410);
  }

  if (session.stripe_checkout_session_id) {
    try {
      const existing = await stripeRequest("/v1/checkout/sessions/" + encodeURIComponent(session.stripe_checkout_session_id));
      const url = typeof existing.url === "string" ? existing.url : null;
      const status = String(existing.status || "");
      if (url && status === "open") {
        return {
          ok: true,
          status: 200,
          body: {
            api_version: API_VERSION,
            checkout_provider: "stripe",
            checkout_mode: "live",
            checkout_session_id: session.stripe_checkout_session_id,
            checkout_url: url,
            plan_id: plan.id,
            plan: { id: plan.id, name: plan.name },
          },
        };
      }
    } catch {
      // Fall through and create a fresh session only if the stored one is unusable.
    }
  }

  const attemptRef = crypto.randomUUID();
  const claimedAt = now.toISOString();
  const { data: claimed, error: claimError } = await client.from("purchase_sessions")
    .update({
      status: "checkout_created",
      checkout_provider: "stripe",
      checkout_reference: attemptRef,
      checkout_created_at: claimedAt,
      updated_at: claimedAt,
    })
    .eq("id", session.id)
    .in("status", ["pending", "checkout_created"])
    .select("id")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return errorResult("session_not_available", "Сесията вече се обработва.", 409);

  const appBaseUrl = getAppBaseUrl();
  const params = new URLSearchParams();
  const recurring = plan.id !== "seven_day";
  params.set("mode", recurring ? "subscription" : "payment");
  params.set("line_items[0][price]", LIVE_STRIPE_PRICES[plan.id]);
  params.set("line_items[0][quantity]", "1");
  params.set("success_url", appBaseUrl + "/payment-status.html?session_id={CHECKOUT_SESSION_ID}");
  params.set("cancel_url", appBaseUrl + "/confirm-plan.html?session=" + encodeURIComponent(normalized));
  params.set("client_reference_id", session.id);
  params.set("metadata[purchase_session_id]", session.id);
  params.set("metadata[telegram_user_id]", String(session.telegram_user_id));
  params.set("metadata[plan_id]", plan.id);
  if (recurring) {
    params.set("subscription_data[metadata][purchase_session_id]", session.id);
    params.set("subscription_data[metadata][telegram_user_id]", String(session.telegram_user_id));
    params.set("subscription_data[metadata][plan_id]", plan.id);
  } else {
    params.set("customer_creation", "always");
    params.set("payment_intent_data[metadata][purchase_session_id]", session.id);
    params.set("payment_intent_data[metadata][telegram_user_id]", String(session.telegram_user_id));
    params.set("payment_intent_data[metadata][plan_id]", plan.id);
  }

  let stripeSession: Record<string, unknown>;
  try {
    stripeSession = await stripeRequest("/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "Idempotency-Key": "purchase_session_" + session.id,
      },
      body: params.toString(),
    });
  } catch (error) {
    await client.from("purchase_sessions").update({
      status: "pending",
      checkout_provider: null,
      checkout_reference: null,
      checkout_created_at: null,
      updated_at: new Date().toISOString(),
    }).eq("id", session.id).eq("checkout_reference", attemptRef);
    throw error;
  }

  const checkoutId = String(stripeSession.id || "");
  const checkoutUrl = typeof stripeSession.url === "string" ? stripeSession.url : "";
  if (!/^cs_live_[A-Za-z0-9_]+$/.test(checkoutId) || !checkoutUrl.startsWith("https://checkout.stripe.com/")) {
    throw new Error("stripe_checkout_invalid_response");
  }

  const checkoutExpiresAt = typeof stripeSession.expires_at === "number"
    ? new Date(Number(stripeSession.expires_at) * 1000).toISOString()
    : null;

  const { error: sessionUpdateError } = await client.from("purchase_sessions").update({
    stripe_checkout_session_id: checkoutId,
    stripe_checkout_expires_at: checkoutExpiresAt,
    checkout_reference: checkoutId,
    updated_at: new Date().toISOString(),
  }).eq("id", session.id).eq("checkout_reference", attemptRef);
  if (sessionUpdateError) throw sessionUpdateError;

  const paymentId = crypto.randomUUID();
  const { error: paymentError } = await client.from("payments").insert({
    id: paymentId,
    telegram_user_id: Number(session.telegram_user_id),
    plan_id: plan.id,
    kind: "initial",
    status: "pending",
    amount_cents: plan.price.amount * 100,
    currency: "eur",
    stripe_checkout_session_id: checkoutId,
    first_stripe_event_id: "checkout_created",
    last_stripe_event_id: "checkout_created",
    provider: "stripe",
    purchase_session_id: session.id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (paymentError && !String(paymentError.message || "").toLowerCase().includes("duplicate")) throw paymentError;

  return {
    ok: true,
    status: 200,
    body: {
      api_version: API_VERSION,
      checkout_provider: "stripe",
      checkout_mode: "live",
      checkout_session_id: checkoutId,
      checkout_url: checkoutUrl,
      plan_id: plan.id,
      plan: { id: plan.id, name: plan.name },
    },
  };
}

async function verifyWebhookEvent(rawBody: string, signature: string, webhookSecret: string): Promise<Record<string, unknown>> {
  const timestampMatch = signature.match(/t=(\d+)/);
  const sigMatches = [...signature.matchAll(/v1=([a-f0-9]+)/g)].map((m) => m[1]);
  if (!timestampMatch || sigMatches.length === 0) throw new Error("Invalid signature format.");
  const timestamp = Number(timestampMatch[1]);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) {
    throw new Error("Webhook timestamp outside tolerance.");
  }
  const payload = `${timestampMatch[1]}.${rawBody}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expectedSig = Array.from(new Uint8Array(sigBytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!sigMatches.some((sig) => safeEqual(sig, expectedSig))) throw new Error("Signature verification failed.");
  return JSON.parse(rawBody);
}

async function sendAutomaticPaymentNotification(
  client: ReturnType<typeof getSupabaseClient>,
  eventId: string | null,
): Promise<Record<string, unknown>> {
  if (!eventId) return { status: "not_queued" };

  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || Deno.env.get("BOT_TOKEN") || Deno.env.get("TELEGRAM_TOKEN") || "";
  if (!/^[0-9]{5,20}:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    return { status: "pending", error_code: "telegram_not_configured" };
  }

  const { data: claimed, error: claimError } = await client.rpc("claim_payment_notification", { p_event_id: eventId });
  if (claimError) throw claimError;
  if (!claimed) {
    const { data } = await client.from("payment_notification_outbox").select("status,last_error_code").eq("id", eventId).maybeSingle();
    return { status: data?.status || "not_found", error_code: data?.last_error_code || null };
  }

  const event = claimed as Record<string, unknown>;
  const plan = PLANS[String(event.plan_id) as PlanId];
  const chatId = String(event.telegram_user_id || "");
  const expiresAt = new Date(String(event.access_expires_at || ""));
  const amountCents = Number(event.amount_cents || 0);

  if (!plan || !/^\d{5,20}$/.test(chatId) || !Number.isFinite(expiresAt.getTime()) || amountCents <= 0) {
    await client.from("payment_notification_outbox").update({
      status: "failed",
      last_error_code: "invalid_verified_payment_event",
      lease_token: null,
      lease_until: null,
      updated_at: new Date().toISOString(),
    }).eq("id", eventId);
    return { status: "failed", error_code: "invalid_verified_payment_event" };
  }

  try {
    const identity = await fetch("https://api.telegram.org/bot" + botToken + "/getMe", {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const identityBody = await identity.json();
    if (!identity.ok || identityBody?.ok !== true || identityBody?.result?.username !== "EliZdraveBot") {
      await client.from("payment_notification_outbox").update({
        status: "retry",
        last_error_code: "eli_bot_identity_not_verified",
        next_attempt_at: new Date(Date.now() + 60000).toISOString(),
        lease_token: null,
        lease_until: null,
        updated_at: new Date().toISOString(),
      }).eq("id", eventId);
      return { status: "retry", error_code: "eli_bot_identity_not_verified" };
    }

    const amount = (amountCents / 100).toLocaleString("bg-BG", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const expiry = new Intl.DateTimeFormat("bg-BG", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
      timeZone: "Europe/Sofia",
    }).format(expiresAt);
    const modes = plan.id === "seven_day"
      ? "текст, глас и Общност"
      : "текст, глас, Avatar видео и Общност";

    const response = await fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: [
          "Плащането ти от " + amount + " € е потвърдено автоматично.",
          plan.name + " е активен до " + expiry + " (българско време).",
          "Включен достъп: " + modes + ".",
          "",
          "Добре дошъл в „Здраве на автопилот“! Аз съм Ели и ще ти помагам стъпка по стъпка.",
          "С /mode можеш да избереш как да общуваш с мен.",
        ].join("\n"),
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: [[{
            text: "Отвори Общността",
            url: getAppBaseUrl() + "/community.html",
          }]],
        },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();

    if (response.ok && body?.ok === true && Number.isSafeInteger(body?.result?.message_id)) {
      const sentAt = new Date().toISOString();
      await client.from("payment_notification_outbox").update({
        status: "sent",
        telegram_message_id: body.result.message_id,
        sent_at: sentAt,
        last_error_code: null,
        lease_token: null,
        lease_until: null,
        updated_at: sentAt,
      }).eq("id", eventId);
      return { status: "sent", delivered_now: true };
    }

    const isRetryable = response.status === 429 || response.status >= 500;
    const nextStatus = isRetryable ? "retry" : "failed";
    await client.from("payment_notification_outbox").update({
      status: nextStatus,
      last_error_code: "telegram_rejected_" + String(body?.error_code || response.status),
      next_attempt_at: isRetryable ? new Date(Date.now() + 60000).toISOString() : new Date().toISOString(),
      lease_token: null,
      lease_until: null,
      updated_at: new Date().toISOString(),
    }).eq("id", eventId);
    return { status: nextStatus, error_code: "telegram_rejected_" + String(body?.error_code || response.status) };
  } catch {
    await client.from("payment_notification_outbox").update({
      status: "uncertain",
      last_error_code: "delivery_outcome_unknown",
      lease_token: null,
      lease_until: null,
      updated_at: new Date().toISOString(),
    }).eq("id", eventId);
    return { status: "uncertain", error_code: "delivery_outcome_unknown" };
  }
}

async function handleCheckoutCompleted(client: ReturnType<typeof getSupabaseClient>, session: Record<string, unknown> | undefined, eventId: string): Promise<Record<string, unknown>> {
  if (!session || String(session.payment_status || "") !== "paid") {
    return { action: "ignored", reason: "payment_not_settled" };
  }

  const checkoutSessionId = String(session.id || "");
  const { data: payment, error } = await client.from("payments").select("*")
    .eq("stripe_checkout_session_id", checkoutSessionId).maybeSingle();
  if (error) throw error;
  if (!payment) return { action: "ignored", reason: "no_matching_payment" };

  if (payment.status === "paid") {
    const { data: existingEvent } = await client.from("payment_notification_outbox")
      .select("id,status").eq("payment_id", payment.id).maybeSingle();
    return {
      action: "already_paid",
      paymentId: payment.id,
      notification: existingEvent ? await sendAutomaticPaymentNotification(client, existingEvent.id) : { status: "not_queued" },
    };
  }

  const now = new Date().toISOString();
  const { error: paymentUpdateError } = await client.from("payments").update({
    status: "paid",
    paid_at: now,
    updated_at: now,
    last_stripe_event_id: eventId,
    stripe_payment_intent_id: session.payment_intent || null,
    stripe_subscription_id: session.subscription || null,
    stripe_customer_id: session.customer || null,
  }).eq("stripe_checkout_session_id", checkoutSessionId);
  if (paymentUpdateError) throw paymentUpdateError;

  const plan = PLANS[payment.plan_id as PlanId];
  if (!plan) throw new Error("unknown_plan");
  const startsAt = new Date();
  const expiresAt = new Date(startsAt.getTime() + plan.durationDays * 86400000);

  const { error: entitlementError } = await client.from("entitlements").upsert({
    telegram_user_id: Number(payment.telegram_user_id),
    plan_id: payment.plan_id,
    status: "active",
    billing_status: payment.plan_id === "seven_day" ? "paid" : "active",
    stripe_customer_id: session.customer || null,
    stripe_subscription_id: session.subscription || null,
    source_payment_id: payment.id,
    starts_at: startsAt.toISOString(),
    current_period_start: startsAt.toISOString(),
    current_period_end: expiresAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    cancel_at_period_end: false,
    updated_at: now,
  }, { onConflict: "telegram_user_id" });
  if (entitlementError) throw entitlementError;

  const { error: sessionError } = await client.from("purchase_sessions").update({
    status: "paid",
    consumed_at: now,
    updated_at: now,
  }).eq("stripe_checkout_session_id", checkoutSessionId).eq("status", "checkout_created");
  if (sessionError) throw sessionError;

  const { data: notificationEvent, error: outboxError } = await client.from("payment_notification_outbox")
    .select("id,status").eq("payment_id", payment.id).maybeSingle();
  if (outboxError) throw outboxError;

  const notification = notificationEvent
    ? await sendAutomaticPaymentNotification(client, notificationEvent.id)
    : { status: "not_queued" };

  return {
    action: "entitlement_activated",
    paymentId: payment.id,
    telegramUserId: payment.telegram_user_id,
    planId: payment.plan_id,
    notification,
  };
}

async function handleCheckoutFailed(client: ReturnType<typeof getSupabaseClient>, session: Record<string, unknown> | undefined, eventId: string, eventType: string): Promise<Record<string, unknown>> {
  if (!session) return { action: "ignored" }; const checkoutSessionId = String(session.id); const { data: payment, error } = await client.from("payments").select("*").eq("stripe_checkout_session_id", checkoutSessionId).maybeSingle(); if (error) throw error; if (!payment) return { action: "ignored" }; const now = new Date().toISOString();
  if (payment.status === "paid" && eventType === "checkout.session.async_payment_failed") { await client.from("payments").update({ status: "failed", failed_at: now, updated_at: now, last_stripe_event_id: eventId }).eq("stripe_checkout_session_id", checkoutSessionId); await client.from("entitlements").update({ status: "cancelled", billing_status: "unpaid", cancel_at_period_end: true, updated_at: now }).eq("telegram_user_id", payment.telegram_user_id).eq("source_payment_id", payment.id); return { action: "payment_failed_entitlement_revoked" }; }
  if (payment.status !== "paid") await client.from("payments").update({ status: "failed", failed_at: now, updated_at: now, last_stripe_event_id: eventId }).eq("stripe_checkout_session_id", checkoutSessionId);
  return { action: "payment_failed" };
}

function stripeSubscriptionIdFromInvoice(invoice: Record<string, unknown>): string | null {
  const direct = typeof invoice.subscription === "string" ? invoice.subscription : null;
  const parent = invoice.parent as Record<string, unknown> | undefined;
  const details = parent?.subscription_details as Record<string, unknown> | undefined;
  const nested = typeof details?.subscription === "string" ? details.subscription : null;
  return direct || nested || null;
}

async function handleInvoicePaid(
  client: ReturnType<typeof getSupabaseClient>,
  invoice: Record<string, unknown> | undefined,
  eventId: string,
): Promise<Record<string, unknown>> {
  if (!invoice) return { action: "ignored", reason: "no_invoice_object" };
  const billingReason = String(invoice.billing_reason || "");
  if (billingReason === "subscription_create") {
    return { action: "ignored", reason: "initial_subscription_invoice_handled_by_checkout" };
  }

  const subscriptionId = stripeSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return { action: "ignored", reason: "no_subscription_id" };

  const { data: entitlement, error: entitlementError } = await client.from("entitlements")
    .select("*").eq("stripe_subscription_id", subscriptionId).maybeSingle();
  if (entitlementError) throw entitlementError;
  if (!entitlement) return { action: "ignored", reason: "no_matching_entitlement" };

  const plan = PLANS[entitlement.plan_id as PlanId];
  if (!plan) throw new Error("unknown_plan");

  const invoiceId = String(invoice.id || "");
  if (!invoiceId) return { action: "ignored", reason: "no_invoice_id" };

  const { data: existing, error: existingError } = await client.from("payments")
    .select("id,status").eq("stripe_invoice_id", invoiceId).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return { action: "already_recorded", paymentId: existing.id };

  const periodStartMs = Number(invoice.period_start || 0) * 1000;
  const periodEndMs = Number(invoice.period_end || 0) * 1000;
  const nowDate = new Date();
  const periodStart = Number.isFinite(periodStartMs) && periodStartMs > 0 ? new Date(periodStartMs) : nowDate;
  const fallbackEnd = new Date(periodStart.getTime() + plan.durationDays * 86400000);
  const periodEnd = Number.isFinite(periodEndMs) && periodEndMs > periodStart.getTime() ? new Date(periodEndMs) : fallbackEnd;
  const amountPaid = Number(invoice.amount_paid || 0);
  const currency = String(invoice.currency || "eur").toLowerCase();
  const now = nowDate.toISOString();

  const { data: sourcePayment, error: sourceError } = await client.from("payments")
    .select("purchase_session_id").eq("id", entitlement.source_payment_id).maybeSingle();
  if (sourceError) throw sourceError;
  if (!sourcePayment?.purchase_session_id) {
    return { action: "ignored", reason: "renewal_missing_origin_session" };
  }

  const paymentId = crypto.randomUUID();
  const { error: paymentInsertError } = await client.from("payments").insert({
    id: paymentId,
    telegram_user_id: Number(entitlement.telegram_user_id),
    plan_id: entitlement.plan_id,
    kind: "renewal",
    status: "paid",
    amount_cents: amountPaid > 0 ? amountPaid : plan.price.amount * 100,
    currency,
    stripe_invoice_id: invoiceId,
    stripe_subscription_id: subscriptionId,
    stripe_customer_id: invoice.customer || entitlement.stripe_customer_id || null,
    first_stripe_event_id: eventId,
    last_stripe_event_id: eventId,
    paid_at: now,
    provider: "stripe",
    purchase_session_id: sourcePayment.purchase_session_id,
    created_at: now,
    updated_at: now,
  });
  if (paymentInsertError) throw paymentInsertError;

  const { error: entitlementUpdateError } = await client.from("entitlements").update({
    status: "active",
    billing_status: "active",
    source_payment_id: paymentId,
    current_period_start: periodStart.toISOString(),
    current_period_end: periodEnd.toISOString(),
    expires_at: periodEnd.toISOString(),
    cancel_at_period_end: false,
    updated_at: now,
  }).eq("telegram_user_id", entitlement.telegram_user_id).eq("stripe_subscription_id", subscriptionId);
  if (entitlementUpdateError) throw entitlementUpdateError;

  const { data: notification, error: notificationError } = await client.from("payment_notification_outbox").insert({
    payment_id: paymentId,
    purchase_session_id: sourcePayment.purchase_session_id,
    telegram_user_id: Number(entitlement.telegram_user_id),
    plan_id: entitlement.plan_id,
    amount_cents: amountPaid > 0 ? amountPaid : plan.price.amount * 100,
    currency,
    paid_at: now,
    access_expires_at: periodEnd.toISOString(),
  }).select("id").maybeSingle();
  if (notificationError) throw notificationError;

  return {
    action: "subscription_renewed",
    paymentId,
    planId: entitlement.plan_id,
    notification: notification?.id ? await sendAutomaticPaymentNotification(client, notification.id) : { status: "not_queued" },
  };
}

async function handleInvoicePaymentFailed(
  client: ReturnType<typeof getSupabaseClient>,
  invoice: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  if (!invoice) return { action: "ignored", reason: "no_invoice_object" };
  const subscriptionId = stripeSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return { action: "ignored", reason: "no_subscription_id" };
  const now = new Date().toISOString();
  const { data, error } = await client.from("entitlements").update({
    billing_status: "past_due",
    updated_at: now,
  }).eq("stripe_subscription_id", subscriptionId).select("telegram_user_id,plan_id,expires_at").maybeSingle();
  if (error) throw error;
  return data ? { action: "subscription_payment_failed", planId: data.plan_id, expiresAt: data.expires_at } : { action: "ignored", reason: "no_matching_entitlement" };
}

async function handleSubscriptionUpdated(
  client: ReturnType<typeof getSupabaseClient>,
  subscription: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  if (!subscription?.id) return { action: "ignored", reason: "no_subscription_object" };
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    updated_at: now,
  };
  const status = String(subscription.status || "");
  if (["active","trialing"].includes(status)) patch.billing_status = status === "active" ? "active" : "trialing";
  if (["past_due","unpaid","canceled"].includes(status)) patch.billing_status = status === "canceled" ? "cancelled" : status;
  const { data, error } = await client.from("entitlements").update(patch)
    .eq("stripe_subscription_id", String(subscription.id))
    .select("telegram_user_id,plan_id").maybeSingle();
  if (error) throw error;
  return data ? { action: "subscription_updated", planId: data.plan_id } : { action: "ignored", reason: "no_matching_entitlement" };
}

async function handleSubscriptionDeleted(
  client: ReturnType<typeof getSupabaseClient>,
  subscription: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  if (!subscription?.id) return { action: "ignored", reason: "no_subscription_object" };
  const nowDate = new Date();
  const { data: current, error: currentError } = await client.from("entitlements")
    .select("telegram_user_id,plan_id,expires_at").eq("stripe_subscription_id", String(subscription.id)).maybeSingle();
  if (currentError) throw currentError;
  if (!current) return { action: "ignored", reason: "no_matching_entitlement" };

  const expired = !current.expires_at || new Date(current.expires_at).getTime() <= nowDate.getTime();
  const { error } = await client.from("entitlements").update({
    status: expired ? "cancelled" : "active",
    billing_status: "cancelled",
    cancel_at_period_end: true,
    updated_at: nowDate.toISOString(),
  }).eq("telegram_user_id", current.telegram_user_id);
  if (error) throw error;

  return { action: "subscription_deleted", planId: current.plan_id, accessRemainsUntilExpiry: !expired };
}

async function processWebhookEvent(client: ReturnType<typeof getSupabaseClient>, event: Record<string, unknown>): Promise<Record<string, unknown>> {
  const type = String(event.type);
  const obj = (event.data as Record<string, unknown>)?.object as Record<string, unknown> | undefined;
  if ((type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") && isAvatarAddonSession(obj)) {
    return handleAvatarAddonCheckoutCompleted(client, obj, String(event.id));
  }
  if ((type === "checkout.session.async_payment_failed" || type === "checkout.session.expired") && isAvatarAddonSession(obj)) {
    return handleAvatarAddonCheckoutFailed(client, obj, String(event.id), type);
  }
  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") return handleCheckoutCompleted(client, obj, String(event.id));
  if (type === "checkout.session.async_payment_failed" || type === "checkout.session.expired") return handleCheckoutFailed(client, obj, String(event.id), type);
  if (type === "invoice.paid") return handleInvoicePaid(client, obj, String(event.id));
  if (type === "invoice.payment_failed") return handleInvoicePaymentFailed(client, obj);
  if (type === "customer.subscription.updated") return handleSubscriptionUpdated(client, obj);
  if (type === "customer.subscription.deleted") return handleSubscriptionDeleted(client, obj);
  return { action: "ignored", reason: "unhandled_event_type: " + type };
}
async function handleWebhook(client: ReturnType<typeof getSupabaseClient>, rawBody: string, signature: string): Promise<Response> {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
  if (!stripeKey || (!stripeKey.startsWith("sk_live_") && !stripeKey.startsWith("rk_live_"))) {
    return sendError(503, "webhook_not_configured", "Webhook обработката не е конфигурирана за LIVE Stripe.");
  }

  let event: Record<string, unknown> | null = null;
  if (secret) {
    try {
      event = await verifyWebhookEvent(rawBody, signature, secret);
    } catch {
      event = null;
    }
  }

  // If the stored signing secret is stale or delivery verification fails,
  // authenticate the event by retrieving the exact event ID from Stripe using the LIVE secret key.
  if (!event) {
    try {
      const candidate = JSON.parse(rawBody) as Record<string, unknown>;
      const eventId = String(candidate?.id || "");
      if (!/^evt_[A-Za-z0-9_]+$/.test(eventId)) throw new Error("invalid_event_id");
      const stripeEvent = await stripeRequest("/v1/events/" + encodeURIComponent(eventId));
      if (String(stripeEvent.id || "") !== eventId) throw new Error("event_id_mismatch");
      event = stripeEvent;
    } catch {
      return sendError(400, "signature_invalid", "Невалидна Stripe подписка.");
    }
  }

  if (event.livemode !== true) return sendJson({ status: 200 }, { received: true, status: "ignored_test_event" });
  const eventId = String(event.id);
  const now = new Date().toISOString();
  const { error: insertError } = await client.from("stripe_events").insert({
    event_id: eventId,
    event_type: String(event.type),
    object_id: String((event.data as any)?.object?.id || null),
    livemode: Boolean(event.livemode),
    status: "processing",
    attempts: 1,
    received_at: now,
    updated_at: now,
  });
  if (insertError) return sendJson({ status: 200 }, { received: true, status: "duplicate" });

  try {
    const result = await processWebhookEvent(client, event);
    await client.from("stripe_events").update({ status: "processed", processed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("event_id", eventId);
    return sendJson({ status: 200 }, { received: true, status: "processed", ...result });
  } catch (err) {
    await client.from("stripe_events").update({ status: "failed", last_error_code: String((err as Error)?.message || "unknown").slice(0, 200), updated_at: new Date().toISOString() }).eq("event_id", eventId);
    return sendJson({ status: 500 }, { received: true, status: "failed" });
  }
}

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

async function resolveEffectiveTelegramUserId(client: ReturnType<typeof getSupabaseClient>, profile: CommunityProfile): Promise<number | null> {
  if (profile.telegram_user_id) return Number(profile.telegram_user_id);
  if (!profile.is_admin) return null;

  const { data: ownerRows, error: ownerError } = await client.from("avatar_owner_generations").select("telegram_user_id").limit(50);
  if (ownerError) throw ownerError;
  const candidateIds = Array.from(new Set((ownerRows || [])
    .map((row: Record<string, unknown>) => Number(row.telegram_user_id))
    .filter((id: number) => Number.isSafeInteger(id) && id > 0)));
  if (candidateIds.length !== 1) return null;

  const candidate = candidateIds[0];
  const { data: entitlement, error: entitlementError } = await client.from("entitlements")
    .select("telegram_user_id").eq("telegram_user_id", candidate).maybeSingle();
  if (entitlementError) throw entitlementError;
  return entitlement ? candidate : null;
}
interface EntitlementInfo { active: boolean; status: string; plan_id: string; is_admin: boolean; }
async function getCommunityEntitlement(client: ReturnType<typeof getSupabaseClient>, profile: CommunityProfile): Promise<EntitlementInfo> { if (profile.is_admin) return { active: true, status: "active", plan_id: "admin", is_admin: true }; if (!profile.telegram_user_id) return { active: false, status: "none", plan_id: "none", is_admin: false }; const { data, error } = await client.from("entitlements").select("status, plan_id, expires_at").eq("telegram_user_id", profile.telegram_user_id).maybeSingle(); if (error) throw error; if (!data) return { active: false, status: "none", plan_id: "none", is_admin: false }; return { active: data.status === "active" && new Date(data.expires_at).getTime() > Date.now(), status: data.status, plan_id: data.plan_id, is_admin: false }; }
function canWrite(e: EntitlementInfo): boolean { return e.active || e.is_admin; }
function validatePostContent(raw: unknown): string | null { if (typeof raw !== "string") return null; const t = raw.trim(); return t.length >= POST_MIN_LENGTH && t.length <= POST_MAX_LENGTH ? t : null; }
function validateDisplayName(raw: unknown): string | null { if (typeof raw !== "string") return null; const t = raw.trim(); return t.length >= 1 && t.length <= DISPLAY_NAME_MAX_LENGTH ? t : null; }
function validateMessageText(raw: unknown): string | null { if (typeof raw !== "string") return null; const t = raw.trim(); return t.length >= 1 && t.length <= MESSAGE_MAX_LENGTH ? t : null; }
async function isBlocked(client: ReturnType<typeof getSupabaseClient>, blockerId: string, blockedId: string): Promise<boolean> { const { data } = await client.from("community_blocks").select("blocker_id").eq("blocker_id", blockerId).eq("blocked_id", blockedId).maybeSingle(); return !!data; }
async function verifyConversationMembership(client: ReturnType<typeof getSupabaseClient>, conversationId: string, userId: string): Promise<boolean> { const { data } = await client.from("private_conversation_members").select("conversation_id").eq("conversation_id", conversationId).eq("user_id", userId).maybeSingle(); return !!data; }
async function getOrCreateConversation(client: ReturnType<typeof getSupabaseClient>, userA: string, userB: string): Promise<string> { const lesser = userA < userB ? userA : userB; const greater = userA < userB ? userB : userA; const { data: existing } = await client.from("private_conversations").select("id").eq("user_a", lesser).eq("user_b", greater).maybeSingle(); if (existing) return existing.id as string; const convId = crypto.randomUUID(); const now = new Date().toISOString(); await client.from("private_conversations").insert({ id: convId, user_a: lesser, user_b: greater, created_at: now }); await client.from("private_conversation_members").insert([{ conversation_id: convId, user_id: userA, created_at: now }, { conversation_id: convId, user_id: userB, created_at: now }]); return convId; }

async function handleGetProfile(req: Request, client: ReturnType<typeof getSupabaseClient>): Promise<Response> { const userId = await getAuthUserId(req, client); if (!userId) return sendError(401, "unauthorized", "Влезте в профила си."); const profile = await getCommunityProfile(client, userId); if (!profile) return sendJson({ status: 200 }, { has_profile: false }); const entitlement = await getCommunityEntitlement(client, profile); const effectiveTelegramUserId = await resolveEffectiveTelegramUserId(client, profile); const internalEntitlement = effectiveTelegramUserId ? await getInternalEntitlement(client, String(effectiveTelegramUserId)) : null; return sendJson({ status: 200 }, { has_profile: true, display_name: profile.display_name, bio: profile.bio, avatar_url: profile.avatar_url, is_admin: profile.is_admin, telegram_linked: profile.telegram_user_id !== null || (profile.is_admin && effectiveTelegramUserId !== null), owner_identity_resolved: profile.is_admin && effectiveTelegramUserId !== null, can_post: canWrite(entitlement), entitlement: { active: entitlement.active, status: entitlement.status, plan_id: entitlement.plan_id, plan_name: internalEntitlement?.plan ? (internalEntitlement.plan as Record<string, unknown>).name : null, billing_status: internalEntitlement?.billing_status || null, current_period_start: internalEntitlement?.current_period_start || null, current_period_end: internalEntitlement?.current_period_end || null, expires_at: internalEntitlement?.expires_at || null, cancel_at_period_end: Boolean(internalEntitlement?.cancel_at_period_end) }, avatar_usage: await getAvatarUsageSnapshot(client, internalEntitlement) }); }
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
    if (segments[1] === "avatar-addons") {
      if (segments.length === 3 && segments[2] === "checkout" && method === "POST") {
        return createAvatarAddonCheckout(req, client);
      }
      if (segments.length === 5 && segments[2] === "checkout" && segments[4] === "status" && method === "GET") {
        return getAvatarAddonCheckoutStatus(req, client, segments[3]);
      }
    }
    if (segments[1] === "community") return handleCommunityRequest(req, client, method, segments);
    return sendError(404,"not_found","Неизвестен маршрут.");
  } catch (error) { console.error("API handler error:", error); return sendError(500,"internal_error","Вътрешна грешка."); }
});
