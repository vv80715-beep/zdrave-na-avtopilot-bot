import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { AFTERCARE_VERSION, DEFAULT_SITE_ORIGIN, ELI_BOT_USERNAME, isUuid, readBotToken, expectedBot, dispatchPaymentNotification } from "../_shared/payment-notification.mjs";
import { notificationStore } from "../_shared/payment-notification-store.mjs";

const env = (name) => Deno.env.get(name);
const siteOrigin = () => (env('APP_BASE_URL') || DEFAULT_SITE_ORIGIN).replace(/\/+$/, '');
const client = () => createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const cors = () => ({
  'access-control-allow-origin': siteOrigin(),
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'cache-control': 'no-store', vary: 'Origin',
});
function json(status, body) {
  return new Response(JSON.stringify({ aftercare_version: AFTERCARE_VERSION, ...body }), {
    status, headers: { ...cors(), 'content-type': 'application/json' },
  });
}
function fail(status, error) { return json(status, { error }); }
function bearer(req) {
  const value = req.headers.get('authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}
async function authenticatedUser(req, db) {
  const token = bearer(req);
  if (!token || token.length > 8192) return null;
  try {
    const { data, error } = await db.auth.getUser(token);
    return !error && data?.user?.id ? data.user.id : null;
  } catch { return null; }
}
async function isAdmin(db, userId) {
  const { data, error } = await db.from('community_profiles').select('is_admin').eq('user_id', userId).maybeSingle();
  return !error && data?.is_admin === true;
}
async function readBody(req) {
  if (Number(req.headers.get('content-length') || 0) > 4096) throw new Error('invalid_body');
  const raw = await req.text();
  if (raw.length > 4096) throw new Error('invalid_body');
  const body = JSON.parse(raw);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_body');
  return body;
}
async function deliver(db, eventId) {
  if (!eventId) return { status: 'not_queued' };
  const store = notificationStore(db);
  const status = await store.status(eventId);
  if (['sent', 'failed', 'uncertain', 'superseded', 'not_found'].includes(status)) return { status, delivered_now: false };
  return dispatchPaymentNotification({ eventId, store, botToken: readBotToken(env), siteOrigin: siteOrigin() });
}
function confirmationError(message) {
  if (message.includes('expired')) return fail(410, 'purchase_session_expired');
  if (message.includes('already') || message.includes('duplicate')) return fail(409, 'payment_or_session_already_used');
  if (message.includes('not_found')) return fail(404, 'purchase_session_not_found');
  if (message.includes('admin') || message.includes('service_role')) return fail(403, 'admin_required');
  if (message.includes('eligible')) return fail(409, 'session_not_eligible_for_revolut_test');
  return fail(400, 'payment_confirmation_rejected');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  const path = new URL(req.url).pathname.replace(/^.*\/payment-aftercare/, '').replace(/\/+$/, '') || '/';
  try {
    const db = client();
    if (req.method === 'GET' && path === '/health') {
      const { error } = await db.from('payment_notification_outbox').select('id').limit(1);
      // Check the exact Supabase secret in this runtime, not the Replit token
      // or a legacy alias. getMe is read-only: no send, claim or webhook change.
      const botToken = readBotToken(name => name === 'TELEGRAM_BOT_TOKEN' ? env(name) : undefined);
      const telegramVerified = await expectedBot(botToken);
      const ready = !error && Boolean(botToken) && telegramVerified;
      return json(ready ? 200 : 503, {
        ready, telegram_configured: Boolean(botToken),
        telegram_identity_verified: telegramVerified,
        telegram_bot_username: telegramVerified ? ELI_BOT_USERNAME : null,
        payment_confirmation: 'manual_owner_confirmation_required',
      });
    }
    const userId = await authenticatedUser(req, db);
    if (!userId) return fail(401, 'unauthorized');

    // A customer may inspect ONLY their linked purchase. This endpoint never confirms a payment.
    if (req.method === 'POST' && path === '/customer/status') {
      let body;
      try { body = await readBody(req); } catch { return fail(400, 'invalid_body'); }
      const token = typeof body.session === 'string' ? body.session.trim() : '';
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) return fail(400, 'invalid_session_token');
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      const hash = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
      const { data: profile, error: pe } = await db.from('community_profiles').select('telegram_user_id').eq('user_id', userId).maybeSingle();
      const { data: session, error: se } = await db.from('purchase_sessions').select('id,telegram_user_id,plan_id,status').eq('token_hash', hash).maybeSingle();
      if (pe || se) return fail(503, 'status_unavailable');
      if (!profile?.telegram_user_id || !session || String(session.telegram_user_id) !== String(profile.telegram_user_id)) return fail(404, 'purchase_session_not_found');
      const { data: payment, error: payError } = await db.from('payments')
        .select('id,status,amount_cents,currency,paid_at').eq('purchase_session_id', session.id).maybeSingle();
      if (payError) return fail(503, 'status_unavailable');
      const confirmed = session.status === 'paid' && payment?.status === 'paid';
      const { data: access, error: ae } = await db.from('entitlements')
        .select('status,plan_id,source_payment_id,expires_at').eq('telegram_user_id', session.telegram_user_id).maybeSingle();
      if (ae) return fail(503, 'status_unavailable');
      return json(200, {
        payment_confirmed: Boolean(confirmed), plan_id: session.plan_id,
        entitlement_active: Boolean(confirmed && access?.status === 'active' && access.source_payment_id === payment.id && Date.parse(access.expires_at) > Date.now()),
        access_expires_at: confirmed && access?.source_payment_id === payment.id ? access.expires_at : null,
      });
    }

    if (!await isAdmin(db, userId)) return fail(403, 'admin_required');
    if (req.method === 'GET' && path === '/admin/overview') {
      const [sessions, notifications] = await Promise.all([
        db.from('purchase_sessions').select('id,telegram_user_id,plan_id,status,created_at,expires_at')
          .eq('checkout_provider', 'revolut_pro_test').eq('status', 'checkout_created')
          .order('created_at', { ascending: false }).limit(50),
        db.from('payment_notification_outbox')
          .select('id,purchase_session_id,telegram_user_id,plan_id,status,attempts,next_attempt_at,access_expires_at,last_error_code,sent_at')
          .eq('event_type', 'payment_confirmed_plan_activated')
          .order('created_at', { ascending: false }).limit(50),
      ]);
      if (sessions.error || notifications.error) return fail(503, 'aftercare_unavailable');
      return json(200, {
        sessions: sessions.data, notifications: notifications.data,
        telegram_configured: Boolean(readBotToken(env)), payment_confirmation: 'manual_owner_confirmation_required',
      });
    }
    if (req.method !== 'POST') return fail(405, 'method_not_allowed');
    let body;
    try { body = await readBody(req); } catch { return fail(400, 'invalid_body'); }
    if (path === '/admin/confirm') {
      if (!isUuid(body.session_id) || typeof body.payment_reference !== 'string'
          || !/^[A-Za-z0-9._:/#-]{6,160}$/.test(body.payment_reference.trim())
          || body.operator_checked !== true || body.amount_cents !== 100 || body.currency !== 'eur') {
        return fail(400, 'owner_must_verify_real_eur_1_payment');
      }
      const { data, error } = await db.rpc('confirm_revolut_payment_aftercare', {
        p_session_id: body.session_id, p_provider_reference: body.payment_reference.trim(),
        p_confirmed_by: userId, p_amount_cents: 100, p_currency: 'eur', p_operator_checked: true,
      });
      if (error) return confirmationError(String(error.message || ''));
      // At this point the transaction has committed. Notification errors must NOT
      // turn the confirmed payment into a failed one or repeat activation.
      let notification;
      try { notification = await deliver(db, data.notification_event_id); }
      catch { notification = { status: 'pending', error_code: 'notification_delivery_deferred' }; }
      return json(200, { confirmed: true, ...data, notification });
    }
    if (path === '/admin/dispatch') {
      if (!isUuid(body.event_id)) return fail(400, 'invalid_notification_event_id');
      return json(200, { notification: await deliver(db, body.event_id) });
    }
    return fail(404, 'not_found');
  } catch {
    // Never log bearer tokens, bot tokens, provider references or fetch URLs.
    return fail(503, 'aftercare_temporarily_unavailable');
  }
});
