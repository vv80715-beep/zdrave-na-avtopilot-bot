-- Expiry is a database transition only. Delivery is performed by a separate
-- service_role worker; cron never contacts Telegram or stores credentials.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

CREATE TABLE public.entitlement_expiry_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id bigint NOT NULL CHECK (telegram_user_id > 0),
  plan_id text NOT NULL,
  period_start timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sending', 'retry', 'sent', 'failed', 'uncertain', 'suppressed')),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  telegram_message_id bigint,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (telegram_user_id, plan_id, period_start, expires_at),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (status NOT IN ('processing', 'sending') OR lease_token IS NOT NULL),
  CHECK (status <> 'sent' OR (sent_at IS NOT NULL AND telegram_message_id IS NOT NULL))
);

CREATE INDEX entitlement_expiry_outbox_due_idx
  ON public.entitlement_expiry_outbox (next_attempt_at, id)
  WHERE status IN ('pending', 'retry', 'processing', 'sending');

ALTER TABLE public.entitlement_expiry_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.entitlement_expiry_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.entitlement_expiry_outbox TO service_role;

CREATE OR REPLACE FUNCTION public.expire_due_entitlements(p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_entitlement record;
  v_inserted integer;
  v_count integer := 0;
BEGIN
  -- Lock entitlements before touching the outbox, just as the claim path does.
  FOR v_entitlement IN
    SELECT telegram_user_id, plan_id, current_period_start, expires_at
    FROM public.entitlements
    WHERE status = 'active' AND expires_at <= now()
    ORDER BY expires_at, telegram_user_id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 0), 1000)
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.entitlements
    SET status = 'expired', updated_at = now()
    WHERE telegram_user_id = v_entitlement.telegram_user_id;

    INSERT INTO public.entitlement_expiry_outbox
      (telegram_user_id, plan_id, period_start, expires_at)
    VALUES
      (v_entitlement.telegram_user_id, v_entitlement.plan_id,
       v_entitlement.current_period_start, v_entitlement.expires_at)
    ON CONFLICT (telegram_user_id, plan_id, period_start, expires_at) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    v_count := v_count + v_inserted;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_entitlement_expiry_notification()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_candidate record;
  v_entitlement record;
  v_event public.entitlement_expiry_outbox%ROWTYPE;
  v_token uuid;
BEGIN
  -- This read does not lock the outbox: always lock the entitlement FIRST.
  -- A finite scan prevents one worker from monopolizing the queue.
  FOR v_candidate IN
    SELECT id, telegram_user_id
    FROM public.entitlement_expiry_outbox
    WHERE (status IN ('pending', 'retry') AND next_attempt_at <= now())
       OR (status IN ('processing', 'sending') AND lease_until <= now())
    ORDER BY next_attempt_at, id
    LIMIT 100
  LOOP
    SELECT plan_id, status, current_period_start, expires_at
      INTO v_entitlement
    FROM public.entitlements
    WHERE telegram_user_id = v_candidate.telegram_user_id
    FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      -- Distinguish a locked renewal from a deleted entitlement. The latter
      -- has no matching period and its notification must be suppressed.
      IF EXISTS (SELECT 1 FROM public.entitlements
                 WHERE telegram_user_id = v_candidate.telegram_user_id) THEN
        CONTINUE;
      END IF;
    END IF;

    SELECT * INTO v_event
    FROM public.entitlement_expiry_outbox
    WHERE id = v_candidate.id
    FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    IF NOT ((v_event.status IN ('pending', 'retry') AND v_event.next_attempt_at <= now())
         OR (v_event.status IN ('processing', 'sending') AND v_event.lease_until <= now())) THEN
      CONTINUE;
    END IF;

    IF v_event.status = 'sending' THEN
      -- Intent was committed: a crash may have occurred after Telegram accepted
      -- the send. Never resend automatically, even if the plan was renewed.
      UPDATE public.entitlement_expiry_outbox
      SET status = 'uncertain', lease_token = NULL, lease_until = NULL,
          last_error_code = 'SEND_OUTCOME_UNKNOWN', updated_at = now()
      WHERE id = v_event.id;
      CONTINUE;
    END IF;

    IF v_entitlement.status IS DISTINCT FROM 'expired'
       OR v_entitlement.plan_id IS DISTINCT FROM v_event.plan_id
       OR v_entitlement.current_period_start IS DISTINCT FROM v_event.period_start
       OR v_entitlement.expires_at IS DISTINCT FROM v_event.expires_at THEN
      UPDATE public.entitlement_expiry_outbox
      SET status = 'suppressed', lease_token = NULL, lease_until = NULL,
          last_error_code = 'STALE_ENTITLEMENT', updated_at = now()
      WHERE id = v_event.id;
      CONTINUE;
    END IF;

    IF v_event.attempts >= 5 THEN
      UPDATE public.entitlement_expiry_outbox
      SET status = 'failed', lease_token = NULL, lease_until = NULL,
          last_error_code = 'ATTEMPT_LIMIT', updated_at = now()
      WHERE id = v_event.id;
      CONTINUE;
    END IF;

    v_token := gen_random_uuid();
    UPDATE public.entitlement_expiry_outbox
    SET status = 'processing', lease_token = v_token,
        lease_until = now() + interval '2 minutes',
        attempts = attempts + 1, updated_at = now()
    WHERE id = v_event.id;
    RETURN jsonb_build_object(
      'id', v_event.id, 'lease_token', v_token,
      'telegram_user_id', v_event.telegram_user_id::text,
      'plan_id', v_event.plan_id, 'period_start', v_event.period_start,
      'expires_at', v_event.expires_at
    );
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_expiry_delivery(p_id uuid, p_lease uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id bigint;
  v_entitlement record;
  v_event public.entitlement_expiry_outbox%ROWTYPE;
BEGIN
  SELECT telegram_user_id INTO v_user_id
  FROM public.entitlement_expiry_outbox WHERE id = p_id;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT plan_id, status, current_period_start, expires_at INTO v_entitlement
  FROM public.entitlements WHERE telegram_user_id = v_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT * INTO v_event
  FROM public.entitlement_expiry_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_event.status <> 'processing'
     OR v_event.lease_token IS DISTINCT FROM p_lease
     OR v_event.lease_until <= now() THEN
    RETURN false;
  END IF;
  IF v_entitlement.status <> 'expired'
     OR v_entitlement.plan_id IS DISTINCT FROM v_event.plan_id
     OR v_entitlement.current_period_start IS DISTINCT FROM v_event.period_start
     OR v_entitlement.expires_at IS DISTINCT FROM v_event.expires_at THEN
    UPDATE public.entitlement_expiry_outbox
    SET status = 'suppressed', lease_token = NULL, lease_until = NULL,
        last_error_code = 'STALE_ENTITLEMENT', updated_at = now()
    WHERE id = p_id;
    RETURN false;
  END IF;

  -- Commit this transaction before calling Telegram. A stale sending lease is
  -- uncertain, never an automatic retry.
  UPDATE public.entitlement_expiry_outbox
  SET status = 'sending', lease_until = now() + interval '5 minutes',
      updated_at = now()
  WHERE id = p_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_expiry_notification(
  p_id uuid, p_lease uuid, p_status text, p_message_id bigint DEFAULT NULL,
  p_error text DEFAULT NULL, p_retry_after integer DEFAULT 60
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_changed integer;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('sent', 'retry', 'failed', 'uncertain')
     OR (p_status = 'sent' AND (p_message_id IS NULL OR p_message_id <= 0 OR p_error IS NOT NULL))
     OR (p_status <> 'sent' AND (p_message_id IS NOT NULL OR NULLIF(p_error, '') IS NULL))
     -- Only an explicit, known Telegram rejection is eligible for a retry.
     OR (p_status = 'retry' AND p_error <> 'rate_limited') THEN
    RETURN false;
  END IF;

  UPDATE public.entitlement_expiry_outbox
  SET status = p_status, lease_token = NULL, lease_until = NULL,
      sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE NULL END,
      telegram_message_id = CASE WHEN p_status = 'sent' THEN p_message_id ELSE NULL END,
      last_error_code = CASE WHEN p_status = 'sent' THEN NULL ELSE left(p_error, 200) END,
      next_attempt_at = CASE WHEN p_status = 'retry'
        THEN now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_retry_after, 60), 60), 3600))
        ELSE next_attempt_at END,
      updated_at = now()
  WHERE id = p_id AND status = 'sending' AND lease_token = p_lease
    AND p_lease IS NOT NULL;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_due_entitlements(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_entitlement_expiry_notification() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_expiry_delivery(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_expiry_notification(uuid, uuid, text, bigint, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_due_entitlements(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_entitlement_expiry_notification() TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_expiry_delivery(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_expiry_notification(uuid, uuid, text, bigint, text, integer)
  TO service_role;

SELECT cron.schedule(
  'expiry-entitlements-minute',
  '* * * * *',
  'SELECT public.expire_due_entitlements(100);'
);

COMMIT;