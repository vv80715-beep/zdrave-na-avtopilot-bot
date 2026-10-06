// All I/O is supplied by the caller. The database RPCs own renewal, period and
// lease checks; this worker never edits billing or entitlement rows directly.
export const MESSAGE = "Your subscription to Zdrave na Avtopilot has expired. Paid features have been disabled, but your profile, progress, and history are preserved. You can renew your subscription using the button below.";
export const RENEW_URL = "https://zdrave-na-avtopilot-dkr6.bolt.host/#plans";
const MAX_BATCH = 10;
const BUDGET_MS = 38_000;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Hashing both sides avoids leaking secret length or a matching prefix. Never
// accept a missing, short, or example deployment secret.
export async function authorized(header, secret) {
  if (typeof secret !== "string" || secret.length < 32 ||
      secret === "replace-with-at-least-32-random-characters") return false;
  const match = typeof header === "string" ? /^Bearer ([^\s]+)$/.exec(header) : null;
  const candidate = match?.[1] ?? "";
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0 && candidate.length === secret.length && match !== null;
}

function validClaim(row) {
  return row && typeof row === "object" && !Array.isArray(row) &&
    typeof row.id === "string" && row.id.length > 0 &&
    typeof row.lease_token === "string" && row.lease_token.length > 0 &&
    typeof row.telegram_user_id === "string" && /^\d{5,20}$/.test(row.telegram_user_id) &&
    typeof row.plan_id === "string" && row.plan_id.length > 0 &&
    typeof row.period_start === "string" && !Number.isNaN(Date.parse(row.period_start)) &&
    typeof row.expires_at === "string" && !Number.isNaN(Date.parse(row.expires_at));
}

function classifyTelegram(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return { p_status: "uncertain", p_error: "malformed_response" };
  }
  const { status, body } = response;
  if (!Number.isInteger(status) || !body || typeof body !== "object" || Array.isArray(body)) {
    return { p_status: "uncertain", p_error: "malformed_response" };
  }
  if (status === 200 && body.ok === true &&
      Number.isSafeInteger(body.result?.message_id) && body.result.message_id > 0) {
    return { p_status: "sent", p_message_id: body.result.message_id };
  }
  if (status === 429 && body.ok === false && body.error_code === 429) {
    const seconds = body.parameters?.retry_after;
    return {
      p_status: "retry",
      p_error: "rate_limited",
      p_retry_after: Number.isInteger(seconds) ? Math.max(1, Math.min(3600, seconds)) : 60,
    };
  }
  if ((status === 400 || status === 403) && body.ok === false &&
      body.error_code === status) {
    return { p_status: "failed", p_error: `telegram_${status}` };
  }
  return { p_status: "uncertain", p_error: "ambiguous_response" };
}

// createStore is deliberately invoked only after both authentication and bot
// identity verification. A false begin is never sent, even if claim succeeded.
export async function handleRequest(request, { secret, botToken, createStore, getMe, sendMessage, now = Date.now }) {
  if (request.method !== "POST" && request.method !== "GET") {
    return json(405, { error: "method_not_allowed" });
  }
  if (!(await authorized(request.headers.get("authorization"), secret))) {
    return json(401, { error: "unauthorized" });
  }
  if (request.method === "GET") {
    return new URL(request.url).pathname.endsWith("/health")
      ? json(200, { ok: true })
      : json(405, { error: "method_not_allowed" });
  }
  if (typeof botToken !== "string" || !botToken.trim()) {
    return json(503, { error: "not_configured" });
  }
  const deadline = now() + BUDGET_MS;
  const remaining = () => Math.max(0, deadline - now());
  try {
    const identity = await getMe(botToken, Math.min(8000, remaining()));
    if (identity?.status !== 200 || identity.body?.ok !== true ||
        identity.body?.result?.username !== "EliZdraveBot") {
      return json(503, { error: "bot_identity_mismatch" });
    }
  } catch {
    return json(503, { error: "bot_identity_unavailable" });
  }

  const totals = { expired: 0, claimed: 0, sent: 0, uncertain: 0, retry: 0, failed: 0, skipped: 0 };
  try {
    const store = createStore();
    const expired = await store.expireDue({ p_limit: 100 });
    if (!Number.isInteger(expired) || expired < 0) throw new Error("invalid_expiry_result");
    totals.expired = expired;
    // Reserve enough time for two bounded database calls, a full send timeout,
    // and two ack attempts. With slower calls the batch simply ends early.
    for (let i = 0; i < MAX_BATCH && remaining() >= 26_000; i++) {
      const row = await store.claim();
      if (row === null) break;
      if (!validClaim(row)) throw new Error("invalid_claim");
      totals.claimed++;
      const args = { p_id: row.id, p_lease: row.lease_token };
      if (await store.begin(args) !== true) {
        totals.skipped++;
        continue;
      }
      // Once begin commits, delivery is never replayed: all ambiguous
      // outcomes (including crashes and missing acks) remain uncertain.
      let outcome;
      try {
        outcome = remaining() < 18_000
          ? { p_status: "uncertain", p_error: "deadline_exceeded" }
          : classifyTelegram(await sendMessage(botToken, {
            chat_id: row.telegram_user_id,
            text: MESSAGE,
            reply_markup: { inline_keyboard: [[{ text: "Renew subscription", url: RENEW_URL }]] },
          }, Math.min(10_000, remaining() - 8000)));
      } catch {
        outcome = { p_status: "uncertain", p_error: "transport_error" };
      }
      // A committed send is not undone by a failed ack. Retry the exact same
      // lease-qualified ack once; never send another Telegram request.
      let acknowledged = false;
      for (let attempt = 0; attempt < 2 && !acknowledged; attempt++) {
        try {
          acknowledged = await store.finish({ ...args, ...outcome }) === true;
        } catch {
          // The same idempotent ack may be retried; delivery may not.
        }
      }
      if (!acknowledged) {
        totals.uncertain++;
        return json(503, { error: "ack_unavailable", ...totals });
      }
      totals[outcome.p_status]++;
    }
    return json(200, { ok: true, ...totals });
  } catch {
    return json(503, { error: "expiry_unavailable", ...totals });
  }
}