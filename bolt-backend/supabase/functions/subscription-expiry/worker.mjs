export const RENEW_URL = "https://zdrave-na-avtopilot-dkr6.bolt.host/#plans";
const MAX_BATCH = 10;
const BUDGET_MS = 38_000;
const PLAN_NAMES = Object.freeze({
  seven_day: "7 дни с Ели",
  monthly: "1 месец с Ели",
  yearly: "1 година с Ели",
});

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

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

function validClaim(row, warning = false) {
  return row && typeof row === "object" && !Array.isArray(row) &&
    typeof row.id === "string" && row.id.length > 0 &&
    typeof row.lease_token === "string" && row.lease_token.length > 0 &&
    typeof row.telegram_user_id === "string" && /^\d{5,20}$/.test(row.telegram_user_id) &&
    typeof row.plan_id === "string" && Object.hasOwn(PLAN_NAMES, row.plan_id) &&
    typeof row.period_start === "string" && !Number.isNaN(Date.parse(row.period_start)) &&
    typeof row.expires_at === "string" && !Number.isNaN(Date.parse(row.expires_at)) &&
    (!warning || ["expiry_soon","payment_failed"].includes(row.warning_kind));
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
      p_status: "retry", p_error: "rate_limited",
      p_retry_after: Number.isInteger(seconds) ? Math.max(1, Math.min(3600, seconds)) : 60,
    };
  }
  if ((status === 400 || status === 403) && body.ok === false && body.error_code === status) {
    return { p_status: "failed", p_error: `telegram_${status}` };
  }
  return { p_status: "uncertain", p_error: "ambiguous_response" };
}

function formatSofia(value) {
  return new Intl.DateTimeFormat("bg-BG", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: "Europe/Sofia",
  }).format(new Date(value));
}

function warningMessage(row) {
  const plan = PLAN_NAMES[row.plan_id] || row.plan_id;
  const until = formatSofia(row.expires_at);
  if (row.warning_kind === "payment_failed") {
    return [
      "⚠️ Не успяхме да подновим абонамента ти автоматично.",
      "",
      `План: ${plan}`,
      `Текущият ти достъп остава активен до ${until} (българско време).`,
      "Ако плащането не бъде успешно до края на периода, Voice/Avatar и пълният достъп до Общността ще бъдат заключени.",
      "Профилът, прогресът, историята и закупените допълнителни Avatar минути няма да се изтрият.",
    ].join("\n");
  }
  return [
    "⏰ Напомняне от Ели: платеният ти абонамент изтича след по-малко от 24 часа.",
    "",
    `План: ${plan}`,
    `Активен до: ${until} (българско време).`,
    "Ако Stripe поднови абонамента успешно, няма да губиш достъп. Ако не бъде платен, платените екстри ще се заключат след изтичането.",
  ].join("\n");
}

function expiryMessage(row) {
  const plan = PLAN_NAMES[row.plan_id] || row.plan_id;
  return [
    "💙 Абонаментът ти изтече.",
    "",
    `План: ${plan}`,
    "Платените функции са заключени до активиране на нов платен план.",
    "Общността вече е само за четене, а Voice/Avatar не са достъпни.",
    "Профилът, прогресът, историята и закупените допълнителни Avatar минути са запазени.",
  ].join("\n");
}

async function deliverQueue({ store, type, sendMessage, botToken, remaining, totals }) {
  const warning = type === "warning";
  const claim = warning ? store.claimWarning : store.claimExpiry;
  const begin = warning ? store.beginWarning : store.beginExpiry;
  const finish = warning ? store.finishWarning : store.finishExpiry;

  for (let i = 0; i < MAX_BATCH && remaining() >= 26_000; i++) {
    const row = await claim();
    if (row === null) break;
    if (!validClaim(row, warning)) throw new Error("invalid_claim");
    totals.claimed++;
    const args = { p_id: row.id, p_lease: row.lease_token };
    if (await begin(args) !== true) {
      totals.skipped++;
      continue;
    }
    let outcome;
    try {
      outcome = remaining() < 18_000
        ? { p_status: "uncertain", p_error: "deadline_exceeded" }
        : classifyTelegram(await sendMessage(botToken, {
          chat_id: row.telegram_user_id,
          text: warning ? warningMessage(row) : expiryMessage(row),
          reply_markup: { inline_keyboard: [[{ text: "Поднови плана", url: RENEW_URL }]] },
        }, Math.min(10_000, remaining() - 8000)));
    } catch {
      outcome = { p_status: "uncertain", p_error: "transport_error" };
    }
    let acknowledged = false;
    for (let attempt = 0; attempt < 2 && !acknowledged; attempt++) {
      try { acknowledged = await finish({ ...args, ...outcome }) === true; } catch {}
    }
    if (!acknowledged) {
      totals.uncertain++;
      return false;
    }
    totals[outcome.p_status]++;
  }
  return true;
}

export async function handleRequest(request, { secret, botToken, createStore, getMe, sendMessage, now = Date.now }) {
  if (request.method !== "POST" && request.method !== "GET") return json(405, { error: "method_not_allowed" });
  if (!(await authorized(request.headers.get("authorization"), secret))) return json(401, { error: "unauthorized" });
  if (request.method === "GET") {
    return new URL(request.url).pathname.endsWith("/health") ? json(200, { ok: true }) : json(405, { error: "method_not_allowed" });
  }
  if (typeof botToken !== "string" || !botToken.trim()) return json(503, { error: "not_configured" });

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

  const totals = { warnings_queued: 0, expired: 0, claimed: 0, sent: 0, uncertain: 0, retry: 0, failed: 0, skipped: 0 };
  try {
    const store = createStore();
    const queued = await store.queueWarnings({ p_limit: 100 });
    if (!Number.isInteger(queued) || queued < 0) throw new Error("invalid_warning_result");
    totals.warnings_queued = queued;

    if (!await deliverQueue({ store, type: "warning", sendMessage, botToken, remaining, totals })) {
      return json(503, { error: "warning_ack_unavailable", ...totals });
    }

    const expired = await store.expireDue({ p_limit: 100 });
    if (!Number.isInteger(expired) || expired < 0) throw new Error("invalid_expiry_result");
    totals.expired = expired;

    if (!await deliverQueue({ store, type: "expiry", sendMessage, botToken, remaining, totals })) {
      return json(503, { error: "expiry_ack_unavailable", ...totals });
    }

    return json(200, { ok: true, ...totals });
  } catch {
    return json(503, { error: "expiry_unavailable", ...totals });
  }
}