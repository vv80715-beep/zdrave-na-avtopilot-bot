import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PROJECT_REF = "aoaylzncorwakxcactox";
const CONTRACT_VERSION = "eli-v2.2/durable-memory/1";
const TABLE = "eli_universal_memory_facts";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-eli-memory-secret",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function validUserId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,20}$/.test(value);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function loadCipherKey() {
  const raw = Deno.env.get("ELI_UNIVERSAL_MEMORY_KEY") || "";
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(raw);
  } catch {
    throw new Error("memory_key_invalid");
  }
  if (bytes.length !== 32 || bytesToBase64(bytes) !== raw) {
    throw new Error("memory_key_invalid");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encrypt(value: string, key: CryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(value),
  );
  return {
    value_iv: bytesToBase64(iv),
    value_ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decrypt(row: Record<string, unknown>, key: CryptoKey) {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(String(row.value_iv)),
    },
    key,
    base64ToBytes(String(row.value_ciphertext)),
  );
  return new TextDecoder().decode(plaintext);
}

async function factForClient(row: Record<string, unknown>, key: CryptoKey) {
  return {
    id: row.id,
    telegram_user_id: row.telegram_user_id,
    category: row.category,
    fact_key: row.fact_key,
    value: await decrypt(row, key),
    status: row.status,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function equalSecret(provided: string, expected: string) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left[i] ^ right[i];
  return mismatch === 0 && Boolean(provided) && Boolean(expected);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const expectedSecret = Deno.env.get("ELI_MEMORY_INTERNAL_SECRET") || "";
  const providedSecret = request.headers.get("x-eli-memory-secret") || "";
  if (!await equalSecret(providedSecret, expectedSecret)) {
    return reply(401, { error: "unauthorized" });
  }

  const ownerId = Deno.env.get("ELI_OWNER_TELEGRAM_ID") || "";
  const projectUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!validUserId(ownerId) || !projectUrl || !serviceKey) {
    return reply(503, { error: "backend_not_configured" });
  }

  let key: CryptoKey;
  let supabase: ReturnType<typeof createClient>;
  try {
    key = await loadCipherKey();
    const host = new URL(projectUrl).hostname;
    if (host !== `${PROJECT_REF}.supabase.co`) throw new Error("project_mismatch");
    supabase = createClient(projectUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch {
    return reply(503, { error: "backend_not_ready" });
  }

  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname.endsWith("/health")) {
    const { error } = await supabase.from(TABLE).select("id").limit(0);
    if (error) return reply(503, { error: "backend_not_ready" });
    return reply(200, {
      status: "ready",
      project_ref: PROJECT_REF,
      contract_version: CONTRACT_VERSION,
    });
  }

  if (request.method === "GET") {
    const userId = url.searchParams.get("telegram_user_id") || "";
    if (userId !== ownerId) return reply(403, { error: "owner_scope_required" });
    const { data, error } = await supabase
      .from(TABLE)
      .select("id,contract_version,telegram_user_id,category,fact_key,value_ciphertext,value_iv,status,source,created_at,updated_at")
      .eq("telegram_user_id", ownerId)
      .eq("status", "active")
      .order("updated_at", { ascending: false });
    if (error) return reply(503, { error: "storage_unavailable" });
    try {
      const facts = await Promise.all((data || []).map((row) => factForClient(row, key)));
      return reply(200, { telegram_user_id: ownerId, facts });
    } catch {
      return reply(503, { error: "memory_decryption_failed" });
    }
  }

  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return reply(400, { error: "invalid_request" });
  }
  if (body.telegram_user_id !== ownerId) return reply(403, { error: "owner_scope_required" });

  if (body.operation === "save_fact") {
    const fact = body.fact as Record<string, unknown> | undefined;
    const value = typeof fact?.value === "string" ? fact.value.trim() : "";
    const category = typeof fact?.category === "string" ? fact.category.trim() : "";
    if (!value || value.length > 240 || !category || category.length > 80) {
      return reply(400, { error: "invalid_fact" });
    }
    try {
      const encrypted = await encrypt(value, key);
      const { data, error } = await supabase.from(TABLE).insert({
        contract_version: CONTRACT_VERSION,
        telegram_user_id: ownerId,
        category,
        fact_key: typeof fact?.fact_key === "string" ? fact.fact_key.slice(0, 80) : null,
        ...encrypted,
        source: typeof fact?.source === "string" ? fact.source.slice(0, 40) : "telegram",
      }).select("*").single();
      if (error || !data) return reply(503, { error: "storage_unavailable" });
      return reply(200, { ok: true, fact: await factForClient(data, key) });
    } catch {
      return reply(503, { error: "memory_write_unverified" });
    }
  }

  const factId = typeof body.fact_id === "string" ? body.fact_id : "";
  if (!factId) return reply(400, { error: "invalid_fact_id" });
  if (body.operation === "update_fact") {
    const value = typeof body.value === "string" ? body.value.trim() : "";
    if (!value || value.length > 240) return reply(400, { error: "invalid_fact" });
    try {
      const encrypted = await encrypt(value, key);
      const { data, error } = await supabase.from(TABLE).update({
        ...encrypted,
        updated_at: new Date().toISOString(),
      }).eq("id", factId).eq("telegram_user_id", ownerId).eq("status", "active")
        .select("*").maybeSingle();
      if (error || !data) return reply(503, { error: "storage_unavailable" });
      return reply(200, {
        ok: true,
        telegram_user_id: ownerId,
        fact: await factForClient(data, key),
      });
    } catch {
      return reply(503, { error: "memory_write_unverified" });
    }
  }

  if (body.operation === "delete_fact") {
    const { data, error } = await supabase.from(TABLE).update({
      status: "deleted",
      updated_at: new Date().toISOString(),
    }).eq("id", factId).eq("telegram_user_id", ownerId).eq("status", "active")
      .select("id").maybeSingle();
    if (error || !data) return reply(503, { error: "storage_unavailable" });
    return reply(200, { ok: true, telegram_user_id: ownerId, fact_id: data.id });
  }

  return reply(400, { error: "unknown_operation" });
});
