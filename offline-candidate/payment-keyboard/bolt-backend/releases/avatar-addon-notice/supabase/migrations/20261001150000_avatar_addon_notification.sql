-- LOCAL CANDIDATE ONLY. Approval required before application.
-- Notification-only extension of the existing outbox; NO backfill or reservation DDL.
BEGIN;

ALTER TABLE public.payment_notification_outbox
  ALTER COLUMN payment_id DROP NOT NULL,
  ALTER COLUMN purchase_session_id DROP NOT NULL,
  ALTER COLUMN plan_id DROP NOT NULL,
  ALTER COLUMN access_expires_at DROP NOT NULL,
  ADD COLUMN addon_purchase_id uuid REFERENCES public.avatar_addon_purchases(id),
  ADD COLUMN addon_checkout_session_id text,
  ADD COLUMN addon_minutes integer,
  ADD COLUMN addon_seconds integer,
  DROP CONSTRAINT payment_notification_outbox_event_type_check,
  ADD CONSTRAINT payment_notification_outbox_event_type_check CHECK (
    event_type IN ('payment_confirmed_plan_activated','payment_confirmed_avatar_addon_credited')
  ),
  ADD CONSTRAINT payment_notification_addon_purchase_unique UNIQUE (addon_purchase_id),
  ADD CONSTRAINT payment_notification_addon_checkout_unique UNIQUE (addon_checkout_session_id),
  ADD CONSTRAINT payment_notification_event_shape CHECK ((
    (event_type = 'payment_confirmed_plan_activated'
      AND payment_id IS NOT NULL AND purchase_session_id IS NOT NULL
      AND plan_id IS NOT NULL AND access_expires_at IS NOT NULL
      AND addon_purchase_id IS NULL AND addon_checkout_session_id IS NULL
      AND addon_minutes IS NULL AND addon_seconds IS NULL)
    OR
    (event_type = 'payment_confirmed_avatar_addon_credited'
      AND payment_id IS NULL AND purchase_session_id IS NULL
      AND plan_id IS NULL AND access_expires_at IS NULL
      AND addon_purchase_id IS NOT NULL
      AND addon_checkout_session_id ~ '^cs_[A-Za-z0-9_]+$'
      AND addon_minutes IN (20,50,100,200) AND addon_seconds = addon_minutes * 60
      AND amount_cents = 50 AND currency = 'eur')
  ) IS TRUE);

-- Live credit function, unchanged except the insert immediately after credit.
-- Existing paid/duplicate branch intentionally does NOT enqueue: no historical notices.
CREATE OR REPLACE FUNCTION public.credit_avatar_addon_purchase(p_purchase_id uuid, p_checkout_session_id text, p_payment_intent_id text, p_event_id text)
 RETURNS TABLE(duplicate boolean, telegram_user_id bigint, credited_seconds integer, addon_purchased_seconds integer, addon_used_seconds integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_purchase public.avatar_addon_purchases%rowtype;
  v_balance public.avatar_addon_balances%rowtype;
begin
  select *
  into v_purchase
  from public.avatar_addon_purchases
  where id = p_purchase_id
  for update;

  if not found then
    raise exception 'avatar_addon_purchase_not_found';
  end if;

  if v_purchase.stripe_checkout_session_id is distinct from p_checkout_session_id then
    raise exception 'avatar_addon_checkout_mismatch';
  end if;

  if v_purchase.status = 'paid' then
    select *
    into v_balance
    from public.avatar_addon_balances
    where avatar_addon_balances.telegram_user_id = v_purchase.telegram_user_id;

    return query
    select true,
           v_purchase.telegram_user_id,
           v_purchase.seconds,
           coalesce(v_balance.purchased_seconds, 0),
           coalesce(v_balance.used_seconds, 0);
    return;
  end if;

  if v_purchase.status not in ('checkout_created','pending') then
    raise exception 'avatar_addon_purchase_not_payable';
  end if;

  insert into public.avatar_addon_balances (
    telegram_user_id,
    purchased_seconds,
    used_seconds,
    created_at,
    updated_at
  )
  values (
    v_purchase.telegram_user_id,
    v_purchase.seconds,
    0,
    now(),
    now()
  )
  on conflict on constraint avatar_addon_balances_pkey
  do update set
    purchased_seconds = public.avatar_addon_balances.purchased_seconds + excluded.purchased_seconds,
    updated_at = now()
  returning * into v_balance;

  update public.avatar_addon_purchases
  set status = 'paid',
      stripe_payment_intent_id = nullif(p_payment_intent_id, ''),
      stripe_event_id = p_event_id,
      paid_at = now(),
      updated_at = now()
  where id = v_purchase.id;

  -- Credit, paid purchase and receipt are atomic; dispatch happens AFTER commit.
  insert into public.payment_notification_outbox (
    event_type, addon_purchase_id, addon_checkout_session_id,
    addon_minutes, addon_seconds, telegram_user_id, amount_cents, currency, paid_at
  )
  values (
    'payment_confirmed_avatar_addon_credited', v_purchase.id, p_checkout_session_id,
    v_purchase.minutes, v_purchase.seconds, v_purchase.telegram_user_id,
    v_purchase.amount_cents, v_purchase.currency::text, now()
  );

  return query
  select false,
         v_purchase.telegram_user_id,
         v_purchase.seconds,
         v_balance.purchased_seconds,
         v_balance.used_seconds;
end;
$function$;

-- Same lease/status/ambiguity semantics; strict event-specific evidence check.
CREATE OR REPLACE FUNCTION public.claim_payment_notification(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_event public.payment_notification_outbox%rowtype;
BEGIN
  IF current_user NOT IN ('service_role','postgres') THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'service_role_required';
  END IF;

  SELECT * INTO v_event
  FROM public.payment_notification_outbox
  WHERE id = p_event_id
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN RETURN NULL; END IF;

  IF v_event.status = 'sending' AND v_event.lease_until <= now() THEN
    UPDATE public.payment_notification_outbox
      SET status = 'uncertain',
          last_error_code = 'delivery_outcome_unknown',
          updated_at = now()
      WHERE id = v_event.id;
    RETURN NULL;
  END IF;

  IF v_event.status NOT IN ('pending','retry')
     OR v_event.next_attempt_at > now()
     OR v_event.attempts >= 5 THEN
    RETURN NULL;
  END IF;

  IF v_event.event_type = 'payment_confirmed_avatar_addon_credited' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.avatar_addon_purchases p
      JOIN public.avatar_addon_balances b ON b.telegram_user_id = p.telegram_user_id
      WHERE p.id = v_event.addon_purchase_id
        AND p.status = 'paid'
        AND p.stripe_checkout_session_id = v_event.addon_checkout_session_id
        AND p.telegram_user_id = v_event.telegram_user_id
        AND p.minutes = v_event.addon_minutes
        AND p.seconds = v_event.addon_seconds
        AND p.minutes IN (20,50,100,200) AND p.seconds = p.minutes * 60
        AND p.package_id = 'addon_' || p.minutes::text
        AND p.amount_cents = 50 AND p.amount_cents = v_event.amount_cents
        AND p.currency::text = 'eur' AND p.currency::text = v_event.currency
        AND p.paid_at = v_event.paid_at AND p.paid_at <= now()
        AND p.stripe_event_id IS NOT NULL
        AND b.purchased_seconds >= p.seconds
        AND v_event.payment_id IS NULL AND v_event.purchase_session_id IS NULL
        AND v_event.plan_id IS NULL AND v_event.access_expires_at IS NULL
    ) THEN
      UPDATE public.payment_notification_outbox
        SET status = 'superseded',
            last_error_code = 'addon_credit_no_longer_matches',
            updated_at = now()
        WHERE id = v_event.id;
      RETURN NULL;
    END IF;
  ELSE
  IF NOT EXISTS (
    SELECT 1
    FROM public.payments p
    JOIN public.entitlements e ON e.source_payment_id = p.id
    JOIN public.purchase_sessions s ON s.id = p.purchase_session_id
    WHERE p.id = v_event.payment_id
      AND p.status = 'paid'
      AND p.telegram_user_id = v_event.telegram_user_id
      AND p.plan_id = v_event.plan_id
      AND p.amount_cents = v_event.amount_cents
      AND p.currency::text = v_event.currency
      AND s.id = v_event.purchase_session_id
      AND s.status = 'paid'
      AND e.telegram_user_id = v_event.telegram_user_id
      AND e.plan_id = v_event.plan_id
      AND e.status = 'active'
      AND e.expires_at > now()
      AND e.expires_at = v_event.access_expires_at
      AND (
        (
          p.provider = 'revolut_manual'
          AND s.checkout_provider = 'revolut_pro_test'
          AND p.manually_confirmed_by IS NOT NULL
          AND p.manually_confirmed_at IS NOT NULL
        )
        OR
        (
          p.provider = 'stripe'
          AND s.checkout_provider = 'stripe'
          AND p.stripe_checkout_session_id IS NOT NULL
          AND p.stripe_checkout_session_id = s.stripe_checkout_session_id
        )
      )
  ) THEN
    UPDATE public.payment_notification_outbox
      SET status = 'superseded',
          last_error_code = 'payment_or_access_no_longer_matches',
          updated_at = now()
      WHERE id = v_event.id;
    RETURN NULL;
  END IF;
  END IF;

  UPDATE public.payment_notification_outbox
    SET status = 'sending',
        attempts = attempts + 1,
        lease_token = gen_random_uuid(),
        lease_until = now() + interval '2 minutes',
        updated_at = now(),
        last_error_code = NULL
    WHERE id = v_event.id
    RETURNING * INTO v_event;

  RETURN to_jsonb(v_event)
    || jsonb_build_object('telegram_user_id', v_event.telegram_user_id::text);
END;
$function$;

-- Explicitly retain the existing service-only grants.
REVOKE ALL ON FUNCTION public.credit_avatar_addon_purchase(uuid,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_avatar_addon_purchase(uuid,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.claim_payment_notification(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payment_notification(uuid) TO service_role;
COMMIT;