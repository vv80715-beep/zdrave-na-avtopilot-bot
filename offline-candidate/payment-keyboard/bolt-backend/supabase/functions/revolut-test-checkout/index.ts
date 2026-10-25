import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Compatibility entry point only. No environment, plan or provider selection.
// The canonical API validates the session and invokes the shared checkout flow.
const API = "https://aoaylzncorwakxcactox.supabase.co/functions/v1/api";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Cache-Control": "no-store",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: "invalid_json" }); }
  const token = typeof body?.session === "string" ? body.session.trim() : "";
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) return json(400, { error: "invalid_session_token" });
  try {
    const response = await fetch(`${API}/purchase-sessions/${encodeURIComponent(token)}/checkout`, {
      method: "POST",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid_response");
    return json(response.status, payload);
  } catch {
    return json(503, {
      error: "checkout_not_configured",
      message: "Checkout временно не е конфигуриран.",
    });
  }
});