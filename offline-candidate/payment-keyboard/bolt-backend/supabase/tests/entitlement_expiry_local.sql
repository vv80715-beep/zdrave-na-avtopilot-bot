-- Run only through run_entitlement_expiry_local.sh against its disposable DB.
CREATE TEMP TABLE assertion_count (n integer NOT NULL);
INSERT INTO assertion_count VALUES (0);
CREATE FUNCTION pg_temp.assert_expiry(ok boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAILED: %', label;
  END IF;
  UPDATE assertion_count SET n = n + 1;
END;
$$;

DO $$
DECLARE
  payload jsonb;
  event_id uuid;
  lease uuid;
  old_id uuid;
BEGIN
  INSERT INTO public.entitlements
    (telegram_user_id, plan_id, status, billing_status, starts_at,
     current_period_start, current_period_end, expires_at, updated_at)
  VALUES
    (11, 'monthly', 'active', 'paid', now()-interval '1 day',
     now()-interval '1 day', now()+interval '1 month', now()+interval '1 month',
     now()-interval '1 day'),
    (9007199254740993, 'monthly', 'active', 'past_due', now()-interval '2 months',
     now()-interval '1 month', now()-interval '1 day', now()-interval '1 day',
     now()-interval '1 day');
  INSERT INTO public.avatar_addon_balances VALUES (9007199254740993, 7200, 120);

  PERFORM pg_temp.assert_expiry(public.expire_due_entitlements(100)=1, 'one due event');
  PERFORM pg_temp.assert_expiry(
    (SELECT status='active' AND updated_at=now()-interval '1 day'
     FROM public.entitlements WHERE telegram_user_id=11), 'future active untouched');
  PERFORM pg_temp.assert_expiry(
    (SELECT status='expired' AND billing_status='past_due'
     FROM public.entitlements WHERE telegram_user_id=9007199254740993),
     'expired status only, billing unchanged');
  PERFORM pg_temp.assert_expiry(
    (SELECT starts_at=now()-interval '2 months'
       AND current_period_start=now()-interval '1 month'
       AND current_period_end=now()-interval '1 day'
       AND expires_at=now()-interval '1 day'
     FROM public.entitlements WHERE telegram_user_id=9007199254740993),
     'period dates unchanged');
  PERFORM pg_temp.assert_expiry(
    (SELECT purchased_seconds=7200 AND used_seconds=120
     FROM public.avatar_addon_balances WHERE telegram_user_id=9007199254740993),
     'addon balance unchanged');
  PERFORM pg_temp.assert_expiry(public.expire_due_entitlements(100)=0, 'expiry idempotent');
  PERFORM pg_temp.assert_expiry(
    (SELECT count(*)=1 FROM public.entitlement_expiry_outbox), 'single event');
  payload:=public.claim_entitlement_expiry_notification();
  PERFORM pg_temp.assert_expiry(
    payload->>'telegram_user_id'='9007199254740993', 'JS-safe text user ID');
  event_id:=(payload->>'id')::uuid;
  lease:=(payload->>'lease_token')::uuid;
  PERFORM pg_temp.assert_expiry(
    public.claim_entitlement_expiry_notification() IS NULL, 'no duplicate claim');
  PERFORM pg_temp.assert_expiry(
    NOT public.begin_expiry_delivery(event_id,gen_random_uuid()), 'wrong lease rejected');
  PERFORM pg_temp.assert_expiry(
    public.begin_expiry_delivery(event_id,lease), 'begin delivery');
  PERFORM pg_temp.assert_expiry(
    NOT public.finish_expiry_notification(event_id,lease,'retry',NULL,'server_error'),
    'ambiguous 5xx cannot retry');
  PERFORM pg_temp.assert_expiry(
    NOT public.finish_expiry_notification(event_id,lease,'sent'),
    'sent requires message ID');
  PERFORM pg_temp.assert_expiry(
    public.finish_expiry_notification(event_id,lease,'sent',42), 'sent acknowledged');
  PERFORM pg_temp.assert_expiry(
    NOT public.finish_expiry_notification(event_id,lease,'sent',42),
    'sent CAS rejects duplicate');
  PERFORM pg_temp.assert_expiry(
    public.claim_entitlement_expiry_notification() IS NULL, 'sent never resent');

  -- Same user, two expired periods: the old event becomes stale, the new one
  -- must be independently recorded and may be claimed.
  INSERT INTO public.entitlements
    (telegram_user_id,plan_id,status,billing_status,starts_at,
     current_period_start,current_period_end,expires_at)
  VALUES (13,'monthly','active','paid',now()-interval '2 months',
    now()-interval '2 months',now()-interval '1 month',now()-interval '1 month');
  PERFORM pg_temp.assert_expiry(public.expire_due_entitlements(100)=1,
    'old period expired');
  SELECT id INTO old_id FROM public.entitlement_expiry_outbox WHERE telegram_user_id=13;
  UPDATE public.entitlements
  SET status='active',current_period_start=now()-interval '1 month',
      current_period_end=now()-interval '1 day',expires_at=now()-interval '1 day'
  WHERE telegram_user_id=13;
  PERFORM pg_temp.assert_expiry(public.expire_due_entitlements(100)=1,
    'renewed period expires separately');
  -- Prioritize the older event; UUID ordering of same-time events is random.
  UPDATE public.entitlement_expiry_outbox
  SET next_attempt_at=now()-interval '1 second' WHERE id=old_id;
  payload:=public.claim_entitlement_expiry_notification();
  PERFORM pg_temp.assert_expiry(
    (SELECT status='suppressed' FROM public.entitlement_expiry_outbox WHERE id=old_id),
    'old period suppressed after renewal');
  PERFORM pg_temp.assert_expiry(
    payload->>'telegram_user_id'='13'
    AND (payload->>'period_start')::timestamptz=now()-interval '1 month',
    'only new period claimed');
  PERFORM pg_temp.assert_expiry(
    (SELECT count(*)=2 FROM public.entitlement_expiry_outbox WHERE telegram_user_id=13),
    'period unique events');
  event_id:=(payload->>'id')::uuid;
  lease:=(payload->>'lease_token')::uuid;
  PERFORM pg_temp.assert_expiry(public.begin_expiry_delivery(event_id,lease),
    'new period begin');
  PERFORM pg_temp.assert_expiry(
    public.finish_expiry_notification(event_id,lease,'failed',NULL,'telegram_blocked'),
    'known permanent failure terminal');

  INSERT INTO public.entitlements
    (telegram_user_id,plan_id,status,billing_status,starts_at,
     current_period_start,current_period_end,expires_at)
  VALUES (14,'monthly','active','paid',now()-interval '1 month',
    now()-interval '1 month',now()-interval '1 day',now()-interval '1 day');
  PERFORM pg_temp.assert_expiry(public.expire_due_entitlements(100)=1,
    'stale fixture expires');
  UPDATE public.entitlements SET status='active', expires_at=now()+interval '1 month'
  WHERE telegram_user_id=14;
  PERFORM pg_temp.assert_expiry(
    public.claim_entitlement_expiry_notification() IS NULL,
    'reactivated stale period not delivered');
  PERFORM pg_temp.assert_expiry(
    (SELECT status='suppressed' FROM public.entitlement_expiry_outbox
     WHERE telegram_user_id=14), 'reactivated event suppressed');

  INSERT INTO public.entitlements
    (telegram_user_id,plan_id,status,billing_status,starts_at,
     current_period_start,current_period_end,expires_at)
  VALUES (15,'monthly','active','paid',now()-interval '1 month',
    now()-interval '1 month',now()-interval '1 day',now()-interval '1 day');
  PERFORM pg_temp.assert_expiry(public.expire_due_entitlements(100)=1,
    'uncertain fixture expires');
  payload:=public.claim_entitlement_expiry_notification();
  event_id:=(payload->>'id')::uuid;
  lease:=(payload->>'lease_token')::uuid;
  PERFORM pg_temp.assert_expiry(public.begin_expiry_delivery(event_id,lease),
    'durable sending intent');
  UPDATE public.entitlement_expiry_outbox SET lease_until=now()-interval '1 second'
  WHERE id=event_id;
  payload:=public.claim_entitlement_expiry_notification();
  PERFORM pg_temp.assert_expiry(payload IS NULL, 'stale sending never reclaimed');
  PERFORM pg_temp.assert_expiry(
    (SELECT status='uncertain' AND lease_token IS NULL
     FROM public.entitlement_expiry_outbox WHERE id=event_id),
    'stale sending uncertain');
  PERFORM pg_temp.assert_expiry(
    NOT public.finish_expiry_notification(event_id,lease,'sent',43),
    'old sending lease cannot finish uncertain');
  PERFORM pg_temp.assert_expiry(
    public.claim_entitlement_expiry_notification() IS NULL,
    'uncertain never resent');

  INSERT INTO public.entitlements
    (telegram_user_id,plan_id,status,billing_status,starts_at,
     current_period_start,current_period_end,expires_at)
  VALUES (16,'monthly','active','paid',now()-interval '1 month',
    now()-interval '1 month',now()-interval '1 day',now()-interval '1 day');
  PERFORM pg_temp.assert_expiry(public.expire_due_entitlements(100)=1,
    'processing fixture expires');
  payload:=public.claim_entitlement_expiry_notification();
  event_id:=(payload->>'id')::uuid;
  lease:=(payload->>'lease_token')::uuid;
  UPDATE public.entitlement_expiry_outbox SET lease_until=now()-interval '1 second'
  WHERE id=event_id;
  payload:=public.claim_entitlement_expiry_notification();
  PERFORM pg_temp.assert_expiry(
    (payload->>'lease_token')::uuid<>lease, 'processing lease safely reclaimed');
  PERFORM pg_temp.assert_expiry(
    (SELECT attempts=2 FROM public.entitlement_expiry_outbox WHERE id=event_id),
    'claim attempts counted');
  PERFORM pg_temp.assert_expiry(
    NOT public.begin_expiry_delivery(event_id,lease), 'old processing lease rejected');
  lease:=(payload->>'lease_token')::uuid;
  PERFORM pg_temp.assert_expiry(public.begin_expiry_delivery(event_id,lease),
    'reclaimed processing lease begins');
  PERFORM pg_temp.assert_expiry(
    public.finish_expiry_notification(event_id,lease,'retry',NULL,'rate_limited',60),
    'explicit rejected 429 retry allowed');
  PERFORM pg_temp.assert_expiry(
    (SELECT status='retry' AND next_attempt_at>now()
     FROM public.entitlement_expiry_outbox WHERE id=event_id),
    'retry is delayed');
  PERFORM pg_temp.assert_expiry(
    (SELECT purchased_seconds=7200 AND used_seconds=120
     FROM public.avatar_addon_balances WHERE telegram_user_id=9007199254740993),
    'addon balance still unchanged');
END;
$$;

SELECT n AS assertions_passed FROM assertion_count;