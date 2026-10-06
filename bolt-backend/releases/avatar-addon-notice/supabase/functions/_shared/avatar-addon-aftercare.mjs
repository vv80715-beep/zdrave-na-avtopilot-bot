import { AVATAR_ADDON_EVENT } from './avatar-addon-notification.mjs';
import { dispatchPaymentNotification, readBotToken } from './payment-notification.mjs';
import { notificationStore } from './payment-notification-store.mjs';

/** Called only after credit RPC committed. This function never creates/backfills events. */
export async function deliverAvatarAddonNotification(db, purchaseId, checkoutSessionId, getEnv) {
  try {
    const { data, error } = await db.from('payment_notification_outbox').select('id,status')
      .eq('event_type', AVATAR_ADDON_EVENT).eq('addon_purchase_id', purchaseId)
      .eq('addon_checkout_session_id', checkoutSessionId).maybeSingle();
    if (error) throw new Error('notification_store_unavailable');
    if (!data) return { status: 'not_queued' };
    if (['sent', 'failed', 'uncertain', 'superseded'].includes(data.status)) {
      return { status: data.status, delivered_now: false };
    }
    return await dispatchPaymentNotification({
      eventId: data.id, store: notificationStore(db), botToken: readBotToken(getEnv),
    });
  } catch {
    // Credit is already committed. Never undo it or retry a potentially sent message here.
    return { status: 'deferred', error_code: 'notification_delivery_deferred' };
  }
}