/** Existing aftercare lease/ack adapter, shared by aftercare and the credit hook. */
export function notificationStore(db) {
  return {
    async claim(id) {
      const { data, error } = await db.rpc('claim_payment_notification', { p_event_id: id });
      if (error) throw new Error('notification_store_unavailable');
      return data;
    },
    async status(id) {
      const { data, error } = await db.from('payment_notification_outbox').select('status').eq('id', id).maybeSingle();
      if (error) throw new Error('notification_store_unavailable');
      return data?.status || 'not_found';
    },
    async finish(event, result) {
      const now = new Date().toISOString();
      const patch = {
        status: result.status, last_error_code: result.error_code || null, updated_at: now,
        lease_token: null, lease_until: null,
        ...(result.status === 'sent' ? { sent_at: now, telegram_message_id: result.message_id } : {}),
        ...(result.status === 'retry' ? { next_attempt_at: new Date(Date.now() + result.retry_after_seconds * 1000).toISOString() } : {}),
      };
      const { data, error } = await db.from('payment_notification_outbox').update(patch)
        .eq('id', event.id).eq('status', 'sending').eq('lease_token', event.lease_token).select('id').maybeSingle();
      if (error || !data) throw new Error('notification_ack_failed');
    },
  };
}