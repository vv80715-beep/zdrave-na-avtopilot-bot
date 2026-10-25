BEGIN;

-- Existing holds were included-only. Defaults preserve their funding, statuses
-- and history; no usage event, purchased balance or payment record is rewritten.
ALTER TABLE public.avatar_generation_reservations
  ADD COLUMN held_included_seconds integer NOT NULL DEFAULT 30,
  ADD COLUMN held_addon_seconds integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT avatar_hold_funding CHECK (
    held_included_seconds >= 0 AND held_addon_seconds >= 0
    AND held_included_seconds + held_addon_seconds = held_seconds);

-- Internal helper: callers MUST hold the existing per-user advisory lock.
-- Included funds belong to one period; purchased funds and their holds are
-- global. Only untouched, expired pre-submit leases may stop holding funds.
CREATE FUNCTION public.avatar_available_funds(
  p_user bigint,p_start timestamptz,p_end timestamptz,p_allow integer
) RETURNS TABLE(included_available bigint,addon_available bigint)
LANGUAGE sql SET search_path = pg_catalog, public AS $$
  SELECT
    GREATEST(p_allow::bigint
      - COALESCE((SELECT sum(included_seconds_charged)
          FROM public.avatar_usage_events
          WHERE telegram_user_id=p_user AND period_start=p_start AND period_end=p_end),0)
      - COALESCE((SELECT sum(held_included_seconds)
          FROM public.avatar_generation_reservations
          WHERE telegram_user_id=p_user AND period_start=p_start AND period_end=p_end
            AND (status IN ('submitting','submitted','uncertain')
              OR (status='reserved' AND created_at>clock_timestamp()-interval '5 minutes' AND period_end>clock_timestamp()))),0),0)::bigint,
    GREATEST(COALESCE((SELECT purchased_seconds::bigint-used_seconds::bigint
          FROM public.avatar_addon_balances WHERE telegram_user_id=p_user),0)
      - COALESCE((SELECT sum(held_addon_seconds)
          FROM public.avatar_generation_reservations
          WHERE telegram_user_id=p_user
            AND (status IN ('submitting','submitted','uncertain')
              OR (status='reserved' AND created_at>clock_timestamp()-interval '5 minutes' AND period_end>clock_timestamp()))),0),0)::bigint;
$$;

CREATE OR REPLACE FUNCTION public.avatar_allowance(p_user bigint,p_request text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e public.entitlements%ROWTYPE; r public.avatar_generation_reservations%ROWTYPE;
  v_start timestamptz; v_end timestamptz; v_included bigint; v_addon bigint;
BEGIN
  IF p_user IS NULL OR p_user<=0 OR p_request IS NULL OR length(p_request) NOT BETWEEN 8 AND 200
    THEN RAISE EXCEPTION 'invalid_avatar_request'; END IF;
  SELECT * INTO e FROM public.entitlements WHERE telegram_user_id=p_user FOR UPDATE;
  PERFORM pg_advisory_xact_lock(p_user);
  IF EXISTS (SELECT 1 FROM public.avatar_owner_generations WHERE request_id=p_request)
    THEN RAISE EXCEPTION 'avatar_request_conflict'; END IF;
  SELECT * INTO r FROM public.avatar_generation_reservations WHERE request_id=p_request;
  IF FOUND THEN
    IF r.telegram_user_id<>p_user THEN RAISE EXCEPTION 'avatar_request_conflict'; END IF;
    RETURN jsonb_build_object('status',r.status,'hold_seconds',r.held_seconds,'video_id',r.video_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.avatar_generation_reservations WHERE telegram_user_id=p_user
    AND status IN ('submitting','submitted','uncertain'))
    OR EXISTS (SELECT 1 FROM public.avatar_owner_generations WHERE telegram_user_id=p_user
    AND status IN ('submitting','submitted','uncertain')) THEN
    RAISE EXCEPTION 'avatar_pending_reconciliation';
  END IF;
  IF e.telegram_user_id IS NULL OR e.status IS DISTINCT FROM 'active'
    OR (e.billing_status IN ('paid','active','trialing')) IS NOT TRUE
    OR (e.plan_id IN ('monthly','yearly')) IS NOT TRUE
    OR e.starts_at IS NULL OR e.expires_at IS NULL
    OR e.current_period_start IS NULL OR e.current_period_end IS NULL
    OR (e.starts_at<=now() AND e.expires_at>now() AND e.current_period_start<e.current_period_end) IS NOT TRUE
    THEN RAISE EXCEPTION 'avatar_plan_inactive'; END IF;
  SELECT period_start,period_end INTO v_start,v_end FROM public.avatar_reservation_period(
    CASE WHEN e.plan_id='yearly' THEN e.starts_at ELSE e.current_period_start END,
    CASE WHEN e.plan_id='yearly' THEN e.expires_at ELSE e.current_period_end END,e.plan_id='yearly');
  IF v_start IS NULL OR v_end IS NULL OR v_start>=v_end OR v_start>now() OR v_end<=now()
    THEN RAISE EXCEPTION 'avatar_period_unavailable'; END IF;
  SELECT included_available,addon_available INTO v_included,v_addon
    FROM public.avatar_available_funds(p_user,v_start,v_end,CASE WHEN e.plan_id='monthly' THEN 1800 ELSE 1200 END);
  RETURN jsonb_build_object('status',CASE WHEN v_included+v_addon>0 THEN 'eligible' ELSE 'exhausted' END,
    'available_seconds',v_included+v_addon);
END;
$$;

CREATE OR REPLACE FUNCTION public.avatar_reserve(p_user bigint,p_request text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e public.entitlements%ROWTYPE; r public.avatar_generation_reservations%ROWTYPE;
  v_start timestamptz; v_end timestamptz; v_included bigint; v_addon bigint;
BEGIN
  IF p_user IS NULL OR p_user<=0 OR p_request IS NULL OR length(p_request) NOT BETWEEN 8 AND 200
    THEN RAISE EXCEPTION 'invalid_avatar_request'; END IF;
  SELECT * INTO e FROM public.entitlements WHERE telegram_user_id=p_user FOR UPDATE;
  PERFORM pg_advisory_xact_lock(p_user);
  IF EXISTS (SELECT 1 FROM public.avatar_owner_generations WHERE request_id=p_request)
    OR EXISTS (SELECT 1 FROM public.avatar_usage_events WHERE request_id=p_request
      AND NOT EXISTS (SELECT 1 FROM public.avatar_generation_reservations WHERE request_id=p_request))
    THEN RAISE EXCEPTION 'avatar_request_conflict'; END IF;
  UPDATE public.avatar_generation_reservations SET status='failed',updated_at=now()
    WHERE telegram_user_id=p_user AND status='reserved'
      AND (created_at<=clock_timestamp()-interval '5 minutes' OR period_end<=clock_timestamp());
  SELECT * INTO r FROM public.avatar_generation_reservations WHERE request_id=p_request;
  IF FOUND THEN
    IF r.telegram_user_id<>p_user THEN RAISE EXCEPTION 'avatar_request_conflict'; END IF;
    RETURN jsonb_build_object('status',r.status,'video_id',r.video_id,'duration_seconds',r.duration_seconds,
      'video_url',r.video_url,'hold_seconds',r.held_seconds);
  END IF;
  IF EXISTS (SELECT 1 FROM public.avatar_generation_reservations WHERE telegram_user_id=p_user
    AND status IN ('submitting','submitted','uncertain'))
    OR EXISTS (SELECT 1 FROM public.avatar_owner_generations WHERE telegram_user_id=p_user
    AND status IN ('submitting','submitted','uncertain')) THEN
    RAISE EXCEPTION 'avatar_pending_reconciliation';
  END IF;
  IF e.telegram_user_id IS NULL OR e.status IS DISTINCT FROM 'active'
    OR (e.billing_status IN ('paid','active','trialing')) IS NOT TRUE
    OR (e.plan_id IN ('monthly','yearly')) IS NOT TRUE
    OR e.starts_at IS NULL OR e.expires_at IS NULL
    OR e.current_period_start IS NULL OR e.current_period_end IS NULL
    OR (e.starts_at<=now() AND e.expires_at>now() AND e.current_period_start<e.current_period_end) IS NOT TRUE
    THEN RAISE EXCEPTION 'avatar_plan_inactive'; END IF;
  SELECT period_start,period_end INTO v_start,v_end FROM public.avatar_reservation_period(
    CASE WHEN e.plan_id='yearly' THEN e.starts_at ELSE e.current_period_start END,
    CASE WHEN e.plan_id='yearly' THEN e.expires_at ELSE e.current_period_end END,e.plan_id='yearly');
  IF v_start IS NULL OR v_end IS NULL OR v_start>=v_end OR v_start>now() OR v_end<=now()
    THEN RAISE EXCEPTION 'avatar_period_unavailable'; END IF;
  UPDATE public.avatar_generation_reservations SET status='failed',updated_at=now()
    WHERE telegram_user_id=p_user AND status='reserved'
      AND (period_start<>v_start OR period_end<>v_end OR plan_id<>e.plan_id);
  SELECT included_available,addon_available INTO v_included,v_addon
    FROM public.avatar_available_funds(p_user,v_start,v_end,CASE WHEN e.plan_id='monthly' THEN 1800 ELSE 1200 END);
  IF v_included+v_addon<30 THEN RAISE EXCEPTION 'avatar_quota_exceeded'; END IF;
  INSERT INTO public.avatar_generation_reservations
    (request_id,telegram_user_id,plan_id,period_start,period_end,held_seconds,status,
     held_included_seconds,held_addon_seconds)
    VALUES (p_request,p_user,e.plan_id,v_start,v_end,30,'reserved',LEAST(v_included,30),30-LEAST(v_included,30));
  RETURN jsonb_build_object('status','reserved','hold_seconds',30,'video_id',NULL);
END;
$$;

-- Refine the existing ledger writer, not a competing debit path. Its public
-- signature, duplicate result and included-first charging contract are unchanged.
-- A direct caller can spend ONLY unheld funds. Reservation-backed recording is
-- permitted only inside completion, after the row is marked settled in the same
-- transaction. Any debit failure rolls that state change back.
CREATE OR REPLACE FUNCTION public.record_avatar_usage(
  p_telegram_user_id bigint,p_request_id text,p_duration_seconds integer,
  p_period_start timestamptz,p_period_end timestamptz,p_included_allowance_seconds integer
) RETURNS TABLE(included_seconds_charged integer,addon_seconds_charged integer,duplicate boolean)
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_existing public.avatar_usage_events%ROWTYPE;
  r public.avatar_generation_reservations%ROWTYPE;
  v_included bigint; v_addon bigint; v_included_charge integer; v_addon_charge integer;
BEGIN
  IF p_telegram_user_id IS NULL OR p_telegram_user_id<=0
    OR p_request_id IS NULL OR length(trim(p_request_id)) NOT BETWEEN 8 AND 200
    OR p_duration_seconds IS NULL OR p_duration_seconds<=0 OR p_duration_seconds>600
    OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end<=p_period_start
    OR p_included_allowance_seconds IS NULL OR p_included_allowance_seconds<0 THEN
    RAISE EXCEPTION 'invalid_avatar_usage_input' USING ERRCODE='22023';
  END IF;
  -- Same lock order as allowance/reserve/transition, including direct callers.
  PERFORM 1 FROM public.entitlements WHERE telegram_user_id=p_telegram_user_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(p_telegram_user_id);
  SELECT * INTO v_existing FROM public.avatar_usage_events WHERE request_id=trim(p_request_id);
  IF FOUND THEN
    IF v_existing.telegram_user_id<>p_telegram_user_id OR v_existing.duration_seconds<>p_duration_seconds THEN
      RAISE EXCEPTION 'avatar_request_id_conflict' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT v_existing.included_seconds_charged,v_existing.addon_seconds_charged,true;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.avatar_owner_generations WHERE request_id=trim(p_request_id))
    THEN RAISE EXCEPTION 'avatar_request_id_conflict' USING ERRCODE='23505'; END IF;
  SELECT * INTO r FROM public.avatar_generation_reservations WHERE request_id=trim(p_request_id);
  IF FOUND AND (r.telegram_user_id<>p_telegram_user_id OR r.status<>'settled'
    OR r.duration_seconds IS DISTINCT FROM p_duration_seconds
    OR r.period_start<>p_period_start OR r.period_end<>p_period_end
    OR p_duration_seconds>r.held_seconds
    OR p_included_allowance_seconds<>CASE WHEN r.plan_id='monthly' THEN 1800 ELSE 1200 END) THEN
    RAISE EXCEPTION 'avatar_request_id_conflict' USING ERRCODE='23505';
  END IF;
  -- Row locking also serializes against existing additive purchase writers.
  PERFORM 1 FROM public.avatar_addon_balances WHERE telegram_user_id=p_telegram_user_id FOR UPDATE;
  SELECT included_available,addon_available INTO v_included,v_addon
    FROM public.avatar_available_funds(p_telegram_user_id,p_period_start,p_period_end,p_included_allowance_seconds);
  v_included_charge := LEAST(p_duration_seconds,v_included);
  v_addon_charge := p_duration_seconds-v_included_charge;
  IF v_addon_charge>v_addon THEN RAISE EXCEPTION 'avatar_quota_exceeded' USING ERRCODE='P0001'; END IF;
  INSERT INTO public.avatar_usage_events
    (telegram_user_id,request_id,duration_seconds,period_start,period_end,included_seconds_charged,addon_seconds_charged)
    VALUES (p_telegram_user_id,trim(p_request_id),p_duration_seconds,p_period_start,p_period_end,v_included_charge,v_addon_charge);
  IF v_addon_charge>0 THEN
    UPDATE public.avatar_addon_balances SET used_seconds=used_seconds+v_addon_charge,updated_at=now()
      WHERE telegram_user_id=p_telegram_user_id;
  END IF;
  RETURN QUERY SELECT v_included_charge,v_addon_charge,false;
END;
$$;

CREATE OR REPLACE FUNCTION public.avatar_transition(
  p_user bigint,p_request text,p_action text,p_video_id text DEFAULT NULL,
  p_duration integer DEFAULT NULL,p_video_url text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e public.entitlements%ROWTYPE; r public.avatar_generation_reservations%ROWTYPE;
  v_start timestamptz; v_end timestamptz;
BEGIN
  IF p_user IS NULL OR p_user<=0 OR p_request IS NULL OR length(p_request) NOT BETWEEN 8 AND 200
    THEN RAISE EXCEPTION 'invalid_avatar_request'; END IF;
  SELECT * INTO e FROM public.entitlements WHERE telegram_user_id=p_user FOR UPDATE;
  PERFORM pg_advisory_xact_lock(p_user);
  SELECT * INTO r FROM public.avatar_generation_reservations WHERE request_id=p_request FOR UPDATE;
  IF NOT FOUND OR r.telegram_user_id<>p_user THEN RAISE EXCEPTION 'avatar_request_not_found'; END IF;
  IF p_action='get' THEN NULL;
  ELSIF p_action='begin' AND r.status='reserved' THEN
    IF e.telegram_user_id IS NULL OR e.status IS DISTINCT FROM 'active'
      OR (e.billing_status IN ('paid','active','trialing')) IS NOT TRUE
      OR (e.plan_id IN ('monthly','yearly')) IS NOT TRUE OR e.plan_id IS DISTINCT FROM r.plan_id
      OR e.starts_at IS NULL OR e.expires_at IS NULL
      OR e.current_period_start IS NULL OR e.current_period_end IS NULL
      OR (e.starts_at<=now() AND e.expires_at>now() AND e.current_period_start<e.current_period_end) IS NOT TRUE
      THEN RAISE EXCEPTION 'avatar_plan_inactive'; END IF;
    SELECT period_start,period_end INTO v_start,v_end FROM public.avatar_reservation_period(
      CASE WHEN e.plan_id='yearly' THEN e.starts_at ELSE e.current_period_start END,
      CASE WHEN e.plan_id='yearly' THEN e.expires_at ELSE e.current_period_end END,e.plan_id='yearly');
    IF v_start IS NULL OR v_end IS NULL OR v_start>=v_end OR v_start>now() OR v_end<=now()
      THEN RAISE EXCEPTION 'avatar_period_unavailable'; END IF;
    -- Wall-clock lease check after locking: a transaction that waited for a
    -- lock must not begin an expired hold another recorder has already reused.
    IF r.created_at<=clock_timestamp()-interval '5 minutes' OR r.period_end<=clock_timestamp()
      OR r.period_start<>v_start OR r.period_end<>v_end THEN
      UPDATE public.avatar_generation_reservations SET status='failed',updated_at=now() WHERE request_id=p_request;
    ELSIF EXISTS (SELECT 1 FROM public.avatar_generation_reservations
      WHERE telegram_user_id=p_user AND request_id<>p_request AND status IN ('submitting','submitted','uncertain'))
      OR EXISTS (SELECT 1 FROM public.avatar_owner_generations
      WHERE telegram_user_id=p_user AND status IN ('submitting','submitted','uncertain')) THEN
      RAISE EXCEPTION 'avatar_pending_reconciliation';
    ELSE
      UPDATE public.avatar_generation_reservations SET status='submitting',updated_at=now() WHERE request_id=p_request;
    END IF;
  ELSIF p_action='job' AND r.status='submitting' AND p_video_id ~ '^[A-Za-z0-9_-]{8,200}$' THEN
    UPDATE public.avatar_generation_reservations SET status='submitted',video_id=p_video_id,updated_at=now() WHERE request_id=p_request;
  ELSIF p_action='uncertain' AND r.status='submitting' THEN
    UPDATE public.avatar_generation_reservations SET status='uncertain',updated_at=now() WHERE request_id=p_request;
  ELSIF p_action='failed' AND r.status IN ('submitting','submitted') THEN
    UPDATE public.avatar_generation_reservations SET status='failed',updated_at=now() WHERE request_id=p_request;
  ELSIF p_action='complete' AND r.status='submitted' AND p_duration BETWEEN 1 AND r.held_seconds
    AND p_video_url ~ '^https://[A-Za-z0-9.-]+/' THEN
    UPDATE public.avatar_generation_reservations SET status='settled',duration_seconds=p_duration,
      video_url=p_video_url,updated_at=now() WHERE request_id=p_request;
    PERFORM public.record_avatar_usage(p_user,p_request,p_duration,r.period_start,r.period_end,
      CASE WHEN r.plan_id='monthly' THEN 1800 ELSE 1200 END);
  ELSIF p_action='complete' AND r.status='settled' AND r.duration_seconds=p_duration AND r.video_url=p_video_url THEN NULL;
  ELSE RAISE EXCEPTION 'avatar_invalid_transition'; END IF;
  SELECT * INTO r FROM public.avatar_generation_reservations WHERE request_id=p_request;
  RETURN jsonb_build_object('status',r.status,'video_id',r.video_id,'hold_seconds',r.held_seconds,
    'duration_seconds',r.duration_seconds,'video_url',r.video_url);
END;
$$;

REVOKE ALL ON FUNCTION public.avatar_available_funds(bigint,timestamptz,timestamptz,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.avatar_available_funds(bigint,timestamptz,timestamptz,integer) TO service_role;
REVOKE ALL ON FUNCTION public.record_avatar_usage(bigint,text,integer,timestamptz,timestamptz,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_avatar_usage(bigint,text,integer,timestamptz,timestamptz,integer) TO service_role;
-- CREATE OR REPLACE preserves the existing service-role-only metering grants.
COMMIT;