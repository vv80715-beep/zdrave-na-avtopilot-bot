// Eli V2.2 durable-memory Edge Function.
// Local deployment material only: do not deploy or migrate without approval.
import { createClient } from 'npm:@supabase/supabase-js@2';

const PROJECT_REF = 'aoaylzncorwakxcactox';
const CONTRACT_VERSION = 'eli-v2.2/durable-memory/1';
const FACT_COLUMNS =
  'id,telegram_user_id,category,fact_key,value,status,source,created_at,updated_at';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });

function validTelegramUserId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{1,19}$/.test(value)) return false;
  try {
    const id = BigInt(value);
    return id > 0n && id <= 9223372036854775807n;
  } catch {
    return false;
  }
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean.length > 0 && clean.length <= maxLength ? clean : null;
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function rowBelongsTo(row: Record<string, unknown> | null, telegramUserId: string) {
  return row !== null &&
    String(row.telegram_user_id) === telegramUserId;
}

Deno.serve(async (req) => {
  const expected = Deno.env.get('ELI_MEMORY_INTERNAL_SECRET');
  const supplied = req.headers.get('x-eli-memory-secret');
  if (!expected || !supplied || supplied !== expected) {
    return json({ error: 'unauthorized' }, 401);
  }

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return json({ error: 'server_not_configured' }, 503);
  try {
    const backend = new URL(url);
    if (
      backend.protocol !== 'https:' ||
      backend.hostname !== `${PROJECT_REF}.supabase.co`
    ) {
      return json({ error: 'server_not_configured' }, 503);
    }
  } catch {
    return json({ error: 'server_not_configured' }, 503);
  }

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
  const parsed = new URL(req.url);
  const isHealthRequest = parsed.pathname.endsWith('/health');

  if (req.method === 'GET' && isHealthRequest) {
    // Schema/access probe only: LIMIT 0 means no user rows are read.
    const { error } = await supabase
      .from('eli_memory_facts')
      .select('id')
      .limit(0);
    if (error) return json({ error: 'backend_not_ready' }, 503);
    return json({
      status: 'ready',
      project_ref: PROJECT_REF,
      contract_version: CONTRACT_VERSION,
    });
  }

  if (req.method === 'GET') {
    const telegramUserId = parsed.searchParams.get('telegram_user_id');
    if (!validTelegramUserId(telegramUserId)) {
      return json({ error: 'invalid_telegram_user_id' }, 400);
    }

    const { data, error } = await supabase
      .from('eli_memory_facts')
      .select(FACT_COLUMNS)
      .eq('telegram_user_id', telegramUserId)
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .limit(500);
    if (error) return json({ error: 'storage_error' }, 500);

    return json({
      telegram_user_id: telegramUserId,
      facts: data || [],
    });
  }

  if (req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ error: 'invalid_request' }, 400);
    }

    const telegramUserId = body.telegram_user_id;
    if (!validTelegramUserId(telegramUserId)) {
      return json({ error: 'invalid_telegram_user_id' }, 400);
    }

    if (body.operation === 'save_fact') {
      const fact = body.fact as Record<string, unknown> | null;
      const category = boundedText(fact?.category, 80);
      const value = boundedText(fact?.value, 240);
      const key = fact?.fact_key == null ? null : boundedText(fact.fact_key, 120);
      const source = fact?.source == null ? 'telegram' : boundedText(fact.source, 40);
      if (!fact || !category || !value || (fact.fact_key != null && !key) || !source) {
        return json({ error: 'invalid_fact' }, 400);
      }

      const { data, error } = await supabase
        .from('eli_memory_facts')
        .insert({
          telegram_user_id: telegramUserId,
          category,
          fact_key: key,
          value,
          source,
          status: 'active',
        })
        .select(FACT_COLUMNS)
        .single();
      if (error || !rowBelongsTo(data, telegramUserId) ||
          data.category !== category || data.value !== value || data.status !== 'active') {
        return json({ error: 'write_not_verified' }, 500);
      }
      return json({ ok: true, telegram_user_id: telegramUserId, fact: data }, 201);
    }

    if (body.operation === 'update_fact') {
      const factId = body.fact_id;
      const value = boundedText(body.value, 240);
      if (!validUuid(factId) || !value) return json({ error: 'invalid_fact_update' }, 400);

      const { data, error } = await supabase
        .from('eli_memory_facts')
        .update({ value, updated_at: new Date().toISOString() })
        .eq('id', factId)
        .eq('telegram_user_id', telegramUserId)
        .eq('status', 'active')
        .select(FACT_COLUMNS)
        .maybeSingle();
      if (error) return json({ error: 'storage_error' }, 500);
      if (!data) return json({ error: 'fact_not_found' }, 404);
      if (!rowBelongsTo(data, telegramUserId) || data.value !== value || data.status !== 'active') {
        return json({ error: 'write_not_verified' }, 500);
      }
      return json({ ok: true, telegram_user_id: telegramUserId, fact: data });
    }

    if (body.operation === 'delete_fact') {
      const factId = body.fact_id;
      if (!validUuid(factId)) return json({ error: 'invalid_fact_id' }, 400);

      // Forgetting is a scoped soft-delete; health events and other users'
      // records are never queried or modified by this endpoint.
      const { data, error } = await supabase
        .from('eli_memory_facts')
        .update({ status: 'deleted', updated_at: new Date().toISOString() })
        .eq('id', factId)
        .eq('telegram_user_id', telegramUserId)
        .eq('status', 'active')
        .select(FACT_COLUMNS)
        .maybeSingle();
      if (error) return json({ error: 'storage_error' }, 500);
      if (!data) return json({ error: 'fact_not_found' }, 404);
      if (!rowBelongsTo(data, telegramUserId) || data.status !== 'deleted') {
        return json({ error: 'write_not_verified' }, 500);
      }
      return json({ ok: true, telegram_user_id: telegramUserId, fact_id: factId });
    }

    return json({ error: 'unknown_operation' }, 400);
  }

  return json({ error: 'method_not_allowed' }, 405);
});
