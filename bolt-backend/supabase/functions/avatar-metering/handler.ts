type RpcResult = { data: unknown; error: { message?: string } | null };
type HandlerConfig = {
  secret?: string | null;
  serviceKey?: string | null;
  ownerId?: string | null;
  rpc: (name: string, params: Record<string, unknown>, key: string) => Promise<RpcResult>;
};

const actions = new Set(["allowance", "reserve", "get", "begin", "job", "uncertain", "failed", "complete", "pending"]);
const fields = new Set(["action", "telegram_user_id", "request_id", "video_id", "duration_seconds", "video_url"]);
function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
async function matches(header: string | null, expected: string | null | undefined) {
  if (!expected || expected.trim().length < 32 || expected === "replace-with-at-least-32-random-characters") return false;
  const candidate = /^Bearer ([^\s]+)$/.exec(header || "")?.[1] || "";
  const encoded = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoded.encode(expected)),
    crypto.subtle.digest("SHA-256", encoded.encode(candidate)),
  ]);
  return candidate.length === expected.length &&
    new Uint8Array(a).every((byte, i) => byte === new Uint8Array(b)[i]);
}

export async function handleAvatarMetering(req: Request, config: HandlerConfig): Promise<Response> {
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (!(await matches(req.headers.get("authorization"), config.secret)))
    return reply(401, { error: "unauthorized" });
  if (!config.serviceKey) return reply(503, { error: "not_configured" });
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_request");
    input = parsed as Record<string, unknown>;
  } catch { return reply(400, { error: "invalid_request" }); }
  // Strict fields: never accept caller-asserted owner/admin/role/scope/hold.
  const action = input.action;
  const user = input.telegram_user_id;
  const id = input.request_id;
  if (Object.keys(input).some((field) => !fields.has(field)) ||
      typeof action !== "string" || !actions.has(action) ||
      typeof user !== "string" || !/^[1-9][0-9]{4,18}$/.test(user) ||
      typeof id !== "string" || !/^tg:[1-9][0-9]{4,18}:[1-9][0-9]{0,18}$/.test(id) ||
      !id.startsWith(`tg:${user}:`)) return reply(400, { error: "invalid_request" });

  // Server-side config only. A missing/malformed owner identity cannot enable
  // a bypass; an ordinary user cannot set it in the authenticated JSON body.
  const trustedOwner = config.ownerId?.trim();
  const owner = !!trustedOwner && /^[1-9][0-9]{4,18}$/.test(trustedOwner) && user === trustedOwner;
  const params = owner
    ? { p_user: user, p_request: id, p_action: action,
        p_video_id: input.video_id ?? null, p_duration: input.duration_seconds ?? null,
        p_video_url: input.video_url ?? null }
    : action === "pending" ? { p_user: user }
    : action === "reserve" || action === "allowance" ? { p_user: user, p_request: id }
    : { p_user: user, p_request: id, p_action: action,
        p_video_id: input.video_id ?? null, p_duration: input.duration_seconds ?? null,
        p_video_url: input.video_url ?? null };
  const rpcName = owner ? "avatar_owner_meter" : action === "reserve" ? "avatar_reserve"
    : action === "pending" ? "avatar_pending" : action === "allowance" ? "avatar_allowance" : "avatar_transition";
  try {
    const { data, error } = await config.rpc(rpcName, params, config.serviceKey);
    if (error) {
      const code = String(error.message || "");
      if (code.includes("avatar_quota_exceeded") || code.includes("avatar_plan_inactive") ||
          code.includes("avatar_invalid_transition") || code.includes("avatar_request_not_found") ||
          code.includes("avatar_pending_reconciliation"))
        return reply(403, { error: code.match(/avatar_(?:quota_exceeded|plan_inactive|invalid_transition|request_not_found|pending_reconciliation)/)?.[0] || "denied" });
      return reply(503, { error: "metering_unavailable" });
    }
    return reply(200, data as Record<string, unknown>);
  } catch {
    return reply(503, { error: "metering_unavailable" });
  }
}