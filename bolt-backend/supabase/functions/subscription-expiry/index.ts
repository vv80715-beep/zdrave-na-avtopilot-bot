import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleRequest } from "./worker.mjs";

const SUPABASE_URL = "https://aoaylzncorwakxcactox.supabase.co";

function telegram(token: string, method: string, payload: Record<string, unknown> | null, timeout: number) {
  if (timeout <= 0) throw new Error("deadline_exceeded");
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: payload ? "POST" : "GET",
    headers: payload ? { "content-type": "application/json" } : {},
    body: payload ? JSON.stringify(payload) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  }).then(async (response) => {
    // A parse error is ambiguous for sendMessage (Telegram may have delivered).
    const body = await response.json();
    return { status: response.status, body };
  });
}

function createStore() {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("service_role_not_configured");
  const client = createClient(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(4000) }),
    },
  });
  async function rpc(name: string, args?: Record<string, unknown>) {
    const { data, error } = await client.rpc(name, args);
    if (error) throw error;
    return data;
  }
  return {
    expireDue: (args: { p_limit: number }) => rpc("expire_due_entitlements", args),
    claim: () => rpc("claim_entitlement_expiry_notification"),
    begin: (args: { p_id: string; p_lease: string }) => rpc("begin_expiry_delivery", args),
    finish: (args: Record<string, unknown>) => rpc("finish_expiry_notification", args),
  };
}

Deno.serve((request: Request) => handleRequest(request, {
  secret: Deno.env.get("BOT_PURCHASE_API_SECRET"),
  botToken: Deno.env.get("TELEGRAM_BOT_TOKEN") ||
    Deno.env.get("BOT_TOKEN") || Deno.env.get("TELEGRAM_TOKEN"),
  createStore,
  getMe: (token: string, timeout: number) => telegram(token, "getMe", null, timeout),
  sendMessage: (token: string, payload: Record<string, unknown>, timeout: number) =>
    telegram(token, "sendMessage", payload, timeout),
}));