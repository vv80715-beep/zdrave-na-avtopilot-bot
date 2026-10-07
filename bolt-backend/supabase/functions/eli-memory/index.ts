// Eli V2.2 durable-memory Edge Function foundation.
// Not deployed by this commit.
import { createClient } from 'npm:@supabase/supabase-js@2';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

Deno.serve(async (req) => {
  const expected = Deno.env.get('ELI_MEMORY_INTERNAL_SECRET');
  const supplied = req.headers.get('x-eli-memory-secret');
  if (!expected || !supplied || supplied !== expected) {
    return json({ error: 'unauthorized' }, 401);
  }

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return json({ error: 'server_not_configured' }, 503);

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  if (req.method === 'GET') {
    const parsed = new URL(req.url);
    const telegramUserId = parsed.searchParams.get('telegram_user_id');
    if (!telegramUserId) return json({ error: 'telegram_user_id_required' }, 400);

    const [profile, facts, events, context] = await Promise.all([
      supabase.from('eli_user_health_profiles').select('*').eq('telegram_user_id', telegramUserId).maybeSingle(),
      supabase.from('eli_memory_facts').select('*').eq('telegram_user_id', telegramUserId).eq('status', 'active').limit(20),
      supabase.from('eli_health_events').select('*').eq('telegram_user_id', telegramUserId).order('occurred_at', { ascending: false }).limit(20),
      supabase.from('eli_short_context').select('*').eq('telegram_user_id', telegramUserId).maybeSingle(),
    ]);

    const error = profile.error || facts.error || events.error || context.error;
    if (error) return json({ error: 'storage_error' }, 500);

    return json({
      telegram_user_id: telegramUserId,
      profile: profile.data,
      facts: facts.data || [],
      events: events.data || [],
      short_context: context.data,
    });
  }

  return json({ error: 'method_not_allowed' }, 405);
});
