/** Render only the durable, claimed credit receipt; never trust Checkout metadata. */
export const AVATAR_ADDON_EVENT = 'payment_confirmed_avatar_addon_credited';
const uuid = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function buildAvatarAddonNotification(event, { now = Date.now() } = {}) {
  const chatId = String(event?.telegram_user_id ?? '');
  const paidAt = Date.parse(event?.paid_at);
  if (event?.event_type !== AVATAR_ADDON_EVENT || event.status !== 'sending'
      || !uuid(event.id) || !uuid(event.addon_purchase_id) || !uuid(event.lease_token)
      || !/^cs_[A-Za-z0-9_]+$/.test(event.addon_checkout_session_id || '')
      || !/^[1-9][0-9]{4,15}$/.test(chatId) || !Number.isSafeInteger(Number(chatId))
      || ![20, 50, 100, 200].includes(event.addon_minutes)
      || event.addon_seconds !== event.addon_minutes * 60
      || event.amount_cents !== 50 || event.currency !== 'eur'
      || !Number.isFinite(paidAt) || paidAt > now + 60000
      || !Number.isInteger(event.attempts) || event.attempts < 1 || event.attempts > 5
      || event.payment_id !== null || event.purchase_session_id !== null
      || event.plan_id !== null || event.access_expires_at !== null) {
    throw new Error('invalid_verified_payment_event');
  }
  return {
    chat_id: chatId,
    text: `✅ Плащането е потвърдено. Добавихме ${event.addon_minutes} допълнителни Avatar минути към профила ти. Те не изтичат и се използват след включеното Avatar време от плана.`,
  };
}