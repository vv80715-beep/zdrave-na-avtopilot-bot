BEGIN;

-- Holds are deliberately separate from the existing settled usage ledger.
-- In particular, an uncertain provider submission is NEVER automatically
-- released: the provider may have accepted a paid generation.
CREATE TABLE public.avatar_generation_reservations (
  request_id text PRIMARY KEY CHECK (length(request_id) BETWEEN 8 AND 200),
  telegram_user_id bigint NOT NULL CHECK (telegram_user_id > 0),
  plan_id text NOT NULL CHECK (plan_id IN ('monthly', 'yearly')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  held_seconds integer NOT NULL DEFAULT 30 CHECK (held_seconds = 30),
  status text NOT NULL CHECK (status IN ('reserved','submitting','submitted','settled','failed','uncertain')),
  video_id text,
  video_url text,
  duration_seconds integer CHECK (duration_seconds BETWEEN 1 AND 600),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
);
CREATE INDEX avatar_generation_active_holds ON public.avatar_generation_reservations(telegram_user_id, period_start, period_end)
  WHERE status IN ('reserved','submitting','submitted','uncertain');
ALTER TABLE public.avatar_generation_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.avatar_generation_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.avatar_generation_reservations TO service_role;

-- Application-role work has its OWN durable scope: no fake customer plan,
-- subscription period, included-usage event, or add-on debit.
CREATE TABLE public.avatar_owner_generations (
  request_id text PRIMARY KEY CHECK (length(request_id) BETWEEN 8 AND 200),
  telegram_user_id bigint NOT NULL CHECK (telegram_user_id > 0),
  held_seconds integer NOT NULL DEFAULT 30 CHECK (held_seconds = 30),
  status text NOT NULL CHECK (status IN ('reserved','submitting','submitted','settled','failed','uncertain')),
  video_id text,
  video_url text,
  duration_seconds integer CHECK (duration_seconds BETWEEN 1 AND 30),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX avatar_owner_pending_jobs ON public.avatar_owner_generations(telegram_user_id,created_at)
  WHERE status IN ('submitting','submitted','uncertain');
ALTER TABLE public.avatar_owner_generations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.avatar_owner_generations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.avatar_owner_generations TO service_role;

-- Keep month-boundary behavior identical to the deployed API's yearly cycle.
CREATE FUNCTION public.avatar_reservation_period(p_start timestamptz, p_end timestamptz, p_yearly boolean)
RETURNS TABLE(period_start timestamptz, period_end timestamptz)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE n integer; v_start timestamptz; v_end timestamptz; v_month timestamp;
BEGIN
  IF NOT p_yearly THEN RETURN QUERY SELECT p_start,p_end; RETURN; END IF;
  v_start := p_start;
  FOR n IN 1..12 LOOP
    -- UTC month clamping, including the original time of day.
    v_month := (date_trunc('month',p_start AT TIME ZONE 'UTC') + make_interval(months => n));
    v_end := LEAST(p_end, (v_month + make_interval(days =>
      LEAST(EXTRACT(day FROM p_start AT TIME ZONE 'UTC')::integer,
        EXTRACT(day FROM (v_month + interval '1 month - 1 day'))::integer) - 1)
      + ((p_start AT TIME ZONE 'UTC') - date_trunc('day',p_start AT TIME ZONE 'UTC'))) AT TIME ZONE 'UTC');
    IF now() < v_end OR v_end >= p_end THEN
      RETURN QUERY SELECT v_start,v_end; RETURN;
    END IF;
    v_start := v_end;
  END LOOP;
  RETURN QUERY SELECT v_start,p_end;
END;
$$;

CREATE FUNCTION public.avatar_allowance(p_user bigint, p_request text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e public.entitlements%ROWTYPE; r public.avatar_generation_reservations%ROWTYPE;
  v_start timestamptz; v_end timestamptz; v_allow integer; v_used integer; v_held integer;
BEGIN
  IF p_user IS NULL OR p_user<=0 OR p_request IS NULL OR length(p_request) NOT BETWEEN 8 AND 200
    THEN RAISE EXCEPTION 'invalid_avatar_request'; END IF;
  SELECT * INTO e FROM public.entitlements WHERE telegram_user_id=p_user FOR UPDATE;
  PERFORM pg_advisory_xact_lock(p_user);
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
    CASE WHEN e.plan_id='yearly' THEN e.expires_at ELSE e.current_period_end END, e.plan_id='yearly');
  IF v_start IS NULL OR v_end IS NULL OR v_start>=v_end OR v_start>now() OR v_end<=now()
    THEN RAISE EXCEPTION 'avatar_period_unavailable'; END IF;
  v_allow := CASE WHEN e.plan_id='monthly' THEN 1800 ELSE 1200 END;
  SELECT COALESCE(sum(included_seconds_charged),0) INTO v_used FROM public.avatar_usage_events
    WHERE telegram_user_id=p_user AND period_start=v_start AND period_end=v_end;
  -- A submitted/ambiguous hold never expires; reserved holds do.
  SELECT COALESCE(sum(held_seconds),0) INTO v_held FROM public.avatar_generation_reservations
    WHERE telegram_user_id=p_user AND period_start=v_start AND period_end=v_end
      AND (status IN ('submitting','submitted','uncertain')
        OR (status='reserved' AND created_at>now()-interval '5 minutes'));
  RETURN jsonb_build_object('status',CASE WHEN v_allow-v_used-v_held>0 THEN 'eligible' ELSE 'exhausted' END,
    'available_seconds',GREATEST(v_allow-v_used-v_held,0));
END;
$$;

CREATE FUNCTION public.avatar_reserve(p_user bigint, p_request text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e public.entitlements%ROWTYPE; r public.avatar_generation_reservations%ROWTYPE;
  v_start timestamptz; v_end timestamptz; v_allow integer; v_used integer;
   v_held_included integer; v_remaining integer;
BEGIN
  IF p_user IS NULL OR p_user <= 0 OR p_request IS NULL OR length(p_request) NOT BETWEEN 8 AND 200
    THEN RAISE EXCEPTION 'invalid_avatar_request'; END IF;
  SELECT * INTO e FROM public.entitlements WHERE telegram_user_id=p_user FOR UPDATE;
  PERFORM pg_advisory_xact_lock(p_user);
  -- Only a 'reserved' row is guaranteed never to have contacted HeyGen.
  -- Expired pre-submit leases and previous-period holds may be reclaimed;
  -- submitting/submitted/uncertain rows MUST remain held for reconciliation.
  UPDATE public.avatar_generation_reservations SET status='failed',updated_at=now()
  WHERE telegram_user_id=p_user AND status='reserved'
    AND (created_at <= now()-interval '5 minutes' OR period_end <= now());
  SELECT * INTO r FROM public.avatar_generation_reservations WHERE request_id=p_request;
  IF FOUND THEN
    IF r.telegram_user_id <> p_user THEN RAISE EXCEPTION 'avatar_request_conflict'; END IF;
    RETURN jsonb_build_object('status',r.status,'video_id',r.video_id,'duration_seconds',r.duration_seconds,'video_url',r.video_url,'hold_seconds',r.held_seconds);
  END IF;
  IF EXISTS (SELECT 1 FROM public.avatar_generation_reservations
             WHERE telegram_user_id=p_user AND status IN ('submitting','submitted','uncertain'))
     OR EXISTS (SELECT 1 FROM public.avatar_owner_generations
             WHERE telegram_user_id=p_user AND status IN ('submitting','submitted','uncertain')) THEN
    RAISE EXCEPTION 'avatar_pending_reconciliation';
  END IF;
  IF e.telegram_user_id IS NULL OR e.status IS DISTINCT FROM 'active'
    OR (e.billing_status IN ('paid','active','trialing')) IS NOT TRUE
    OR (e.plan_id IN ('monthly','yearly')) IS NOT TRUE
    OR e.starts_at IS NULL OR e.expires_at IS NULL
    OR e.current_period_start IS NULL OR e.current_period_end IS NULL
    OR (e.starts_at <= now() AND e.expires_at > now()
        AND e.current_period_start < e.current_period_end) IS NOT TRUE
    THEN RAISE EXCEPTION 'avatar_plan_inactive'; END IF;
  SELECT period_start,period_end INTO v_start,v_end FROM public.avatar_reservation_period(
    CASE WHEN e.plan_id='yearly' THEN e.starts_at ELSE e.current_period_start END,
    CASE WHEN e.plan_id='yearly' THEN e.expires_at ELSE e.current_period_end END, e.plan_id='yearly');
  IF v_start IS NULL OR v_end IS NULL OR v_start >= v_end
     OR v_start > now() OR v_end <= now() THEN
    RAISE EXCEPTION 'avatar_period_unavailable';
  END IF;
  -- Reactivation/renewal may change the period before its previous end.
  UPDATE public.avatar_generation_reservations SET status='failed',updated_at=now()
  WHERE telegram_user_id=p_user AND status='reserved'
    AND (period_start <> v_start OR period_end <> v_end OR plan_id <> e.plan_id);
  v_allow := CASE WHEN e.plan_id='monthly' THEN 1800 ELSE 1200 END;
  SELECT COALESCE(sum(included_seconds_charged),0) INTO v_used
  FROM public.avatar_usage_events WHERE telegram_user_id=p_user AND period_start=v_start AND period_end=v_end;
  SELECT COALESCE(sum(held_seconds),0) INTO v_held_included FROM public.avatar_generation_reservations
  WHERE telegram_user_id=p_user AND period_start=v_start AND period_end=v_end AND status IN ('reserved','submitting','submitted','uncertain');
  v_remaining := GREATEST(v_allow-v_used-v_held_included,0);
  -- Server-owned, non-negotiable 30-second hold. Client-supplied durations
  -- cannot change this amount; actual <=30 seconds settle at actual length.
  IF v_remaining < 30 THEN RAISE EXCEPTION 'avatar_quota_exceeded'; END IF;
  INSERT INTO public.avatar_generation_reservations
    (request_id,telegram_user_id,plan_id,period_start,period_end,held_seconds,status)
    VALUES (p_request,p_user,e.plan_id,v_start,v_end,30,'reserved');
  RETURN jsonb_build_object('status','reserved','hold_seconds',30,'video_id',NULL);
END;
$$;

CREATE FUNCTION public.avatar_transition(p_user bigint,p_request text,p_action text,p_video_id text DEFAULT NULL,p_duration integer DEFAULT NULL,p_video_url text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e public.entitlements%ROWTYPE; r public.avatar_generation_reservations%ROWTYPE;
  v_allow integer; v_used integer; v_start timestamptz; v_end timestamptz;
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
       OR (e.plan_id IN ('monthly','yearly')) IS NOT TRUE
       OR e.plan_id IS DISTINCT FROM r.plan_id
       OR e.starts_at IS NULL OR e.expires_at IS NULL
       OR e.current_period_start IS NULL OR e.current_period_end IS NULL
       OR (e.starts_at <= now() AND e.expires_at > now()
           AND e.current_period_start < e.current_period_end) IS NOT TRUE
      THEN RAISE EXCEPTION 'avatar_plan_inactive'; END IF;
    SELECT period_start,period_end INTO v_start,v_end FROM public.avatar_reservation_period(
      CASE WHEN e.plan_id='yearly' THEN e.starts_at ELSE e.current_period_start END,
      CASE WHEN e.plan_id='yearly' THEN e.expires_at ELSE e.current_period_end END, e.plan_id='yearly');
    IF v_start IS NULL OR v_end IS NULL OR v_start >= v_end
       OR v_start > now() OR v_end <= now()
      THEN RAISE EXCEPTION 'avatar_period_unavailable'; END IF;
    IF r.created_at <= now()-interval '5 minutes'
       OR r.period_start <> v_start OR r.period_end <> v_end THEN
      UPDATE public.avatar_generation_reservations SET status='failed',updated_at=now()
        WHERE request_id=p_request;
    ELSIF EXISTS (SELECT 1 FROM public.avatar_generation_reservations
               WHERE telegram_user_id=p_user AND request_id<>p_request
                  AND status IN ('submitting','submitted','uncertain'))
       OR EXISTS (SELECT 1 FROM public.avatar_owner_generations
                  WHERE telegram_user_id=p_user AND status IN ('submitting','submitted','uncertain')) THEN
      RAISE EXCEPTION 'avatar_pending_reconciliation';
    ELSE
      -- This is a single compare-and-set under the per-user lock: only the
      -- transaction that changed reserved -> submitting may call the provider.
      UPDATE public.avatar_generation_reservations SET status='submitting',updated_at=now()
        WHERE request_id=p_request;
    END IF;
  ELSIF p_action='job' AND r.status='submitting' AND p_video_id ~ '^[A-Za-z0-9_-]{8,200}$' THEN
    UPDATE public.avatar_generation_reservations SET status='submitted',video_id=p_video_id,updated_at=now() WHERE request_id=p_request;
  ELSIF p_action='uncertain' AND r.status='submitting' THEN
    UPDATE public.avatar_generation_reservations SET status='uncertain',updated_at=now() WHERE request_id=p_request;
  ELSIF p_action='failed' AND r.status IN ('submitting','submitted') THEN
    UPDATE public.avatar_generation_reservations SET status='failed',updated_at=now() WHERE request_id=p_request;
  ELSIF p_action='complete' AND r.status='submitted' AND p_duration BETWEEN 1 AND r.held_seconds
    AND p_video_url ~ '^https://[A-Za-z0-9.-]+/' THEN
    v_allow := CASE WHEN r.plan_id='monthly' THEN 1800 ELSE 1200 END;
    -- Exclusive included allowance, never the purchased add-on RPC/balance.
    -- Same per-user advisory lock as the existing settled-usage RPC.
    SELECT COALESCE(sum(included_seconds_charged),0) INTO v_used FROM public.avatar_usage_events
      WHERE telegram_user_id=p_user AND period_start=r.period_start AND period_end=r.period_end;
    IF v_used+p_duration>v_allow THEN RAISE EXCEPTION 'avatar_quota_exceeded'; END IF;
    INSERT INTO public.avatar_usage_events(
      telegram_user_id,request_id,duration_seconds,period_start,period_end,
      included_seconds_charged,addon_seconds_charged
    ) VALUES (p_user,p_request,p_duration,r.period_start,r.period_end,p_duration,0);
    UPDATE public.avatar_generation_reservations SET status='settled',duration_seconds=p_duration,
      video_url=p_video_url,updated_at=now() WHERE request_id=p_request;
  ELSIF p_action='complete' AND r.status='settled' AND r.duration_seconds=p_duration
    AND r.video_url=p_video_url THEN NULL;
  ELSE RAISE EXCEPTION 'avatar_invalid_transition'; END IF;
  SELECT * INTO r FROM public.avatar_generation_reservations WHERE request_id=p_request;
  RETURN jsonb_build_object('status',r.status,'video_id',r.video_id,'hold_seconds',r.held_seconds,
    'duration_seconds',r.duration_seconds,'video_url',r.video_url);
END;
$$;

CREATE FUNCTION public.avatar_pending(p_user bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.avatar_generation_reservations%ROWTYPE;
BEGIN
  IF p_user IS NULL OR p_user<=0 THEN RAISE EXCEPTION 'invalid_avatar_user'; END IF;
  PERFORM pg_advisory_xact_lock(p_user);
  SELECT * INTO r FROM public.avatar_generation_reservations WHERE telegram_user_id=p_user
    AND status IN ('submitting','submitted','uncertain') ORDER BY created_at,request_id LIMIT 1;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.avatar_owner_generations WHERE telegram_user_id=p_user
               AND status IN ('submitting','submitted','uncertain')) THEN
      RETURN jsonb_build_object('status','uncertain','hold_seconds',30);
    END IF;
    RETURN jsonb_build_object('status','none');
  END IF;
  RETURN jsonb_build_object('status',r.status,'request_id',r.request_id,
    'video_id',r.video_id,'hold_seconds',r.held_seconds);
END;
$$;

-- Only the authenticated Edge Function may choose this service-role-only RPC.
-- It compares the Telegram sender with its OWN OWNER_TELEGRAM_ID environment
-- setting. There is deliberately no caller-supplied is_owner argument.
CREATE FUNCTION public.avatar_owner_meter(
  p_user bigint,p_request text,p_action text,
  p_video_id text DEFAULT NULL,p_duration integer DEFAULT NULL,p_video_url text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.avatar_owner_generations%ROWTYPE; c public.avatar_generation_reservations%ROWTYPE;
BEGIN
  IF p_user IS NULL OR p_user<=0 OR p_request IS NULL
     OR p_request !~ ('^tg:' || p_user::text || ':[1-9][0-9]{0,18}$')
     THEN RAISE EXCEPTION 'invalid_avatar_request'; END IF;
  PERFORM pg_advisory_xact_lock(p_user);
  IF p_action='pending' THEN
    -- A job started as a customer must not be forgotten when the configured
    -- owner identity changes. Hold new work for operator reconciliation.
    IF EXISTS (SELECT 1 FROM public.avatar_generation_reservations
               WHERE telegram_user_id=p_user AND status IN ('submitting','submitted','uncertain')) THEN
      RETURN jsonb_build_object('status','uncertain','hold_seconds',30);
    END IF;
    SELECT * INTO r FROM public.avatar_owner_generations WHERE telegram_user_id=p_user
      AND status IN ('submitting','submitted','uncertain') ORDER BY created_at,request_id LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','none'); END IF;
    RETURN jsonb_build_object('status',r.status,'request_id',r.request_id,
      'video_id',r.video_id,'hold_seconds',r.held_seconds);
  END IF;
  SELECT * INTO c FROM public.avatar_generation_reservations WHERE request_id=p_request;
  IF FOUND THEN RAISE EXCEPTION 'avatar_request_conflict'; END IF;
  IF p_action='reserve' THEN
    -- Only an untouched pre-submit claim may expire automatically.
    UPDATE public.avatar_owner_generations SET status='failed',updated_at=now()
      WHERE telegram_user_id=p_user AND status='reserved'
        AND created_at<=now()-interval '5 minutes';
  END IF;
  SELECT * INTO r FROM public.avatar_owner_generations WHERE request_id=p_request FOR UPDATE;
  IF FOUND AND r.telegram_user_id<>p_user THEN RAISE EXCEPTION 'avatar_request_conflict'; END IF;
  IF p_action IN ('allowance','reserve') THEN
    IF FOUND THEN
      RETURN jsonb_build_object('status',r.status,'hold_seconds',r.held_seconds,
        'video_id',r.video_id,'duration_seconds',r.duration_seconds,'video_url',r.video_url);
    END IF;
    IF EXISTS (SELECT 1 FROM public.avatar_owner_generations WHERE telegram_user_id=p_user
               AND status IN ('submitting','submitted','uncertain'))
       OR EXISTS (SELECT 1 FROM public.avatar_generation_reservations WHERE telegram_user_id=p_user
               AND status IN ('submitting','submitted','uncertain')) THEN
      RAISE EXCEPTION 'avatar_pending_reconciliation';
    END IF;
    IF p_action='allowance' THEN
      RETURN jsonb_build_object('status','eligible','available_seconds',30);
    END IF;
    INSERT INTO public.avatar_owner_generations(request_id,telegram_user_id,held_seconds,status)
      VALUES(p_request,p_user,30,'reserved');
  ELSIF NOT FOUND THEN
    RAISE EXCEPTION 'avatar_request_not_found';
  ELSIF p_action='get' THEN NULL;
  ELSIF p_action='begin' AND r.status='reserved' THEN
    IF r.created_at<=now()-interval '5 minutes' THEN
      UPDATE public.avatar_owner_generations SET status='failed',updated_at=now() WHERE request_id=p_request;
    ELSIF EXISTS (SELECT 1 FROM public.avatar_owner_generations WHERE telegram_user_id=p_user
                 AND request_id<>p_request AND status IN ('submitting','submitted','uncertain'))
       OR EXISTS (SELECT 1 FROM public.avatar_generation_reservations WHERE telegram_user_id=p_user
                 AND status IN ('submitting','submitted','uncertain')) THEN
      RAISE EXCEPTION 'avatar_pending_reconciliation';
    ELSE
      UPDATE public.avatar_owner_generations SET status='submitting',updated_at=now()
        WHERE request_id=p_request;
    END IF;
  ELSIF p_action='job' AND r.status='submitting' AND p_video_id ~ '^[A-Za-z0-9_-]{8,200}$' THEN
    UPDATE public.avatar_owner_generations SET status='submitted',video_id=p_video_id,updated_at=now()
      WHERE request_id=p_request;
  ELSIF p_action='uncertain' AND r.status='submitting' THEN
    UPDATE public.avatar_owner_generations SET status='uncertain',updated_at=now() WHERE request_id=p_request;
  ELSIF p_action='failed' AND r.status IN ('submitting','submitted') THEN
    UPDATE public.avatar_owner_generations SET status='failed',updated_at=now() WHERE request_id=p_request;
  ELSIF p_action='complete' AND r.status='submitted' AND p_duration BETWEEN 1 AND 30
        AND p_video_url ~ '^https://[A-Za-z0-9.-]+/' THEN
    UPDATE public.avatar_owner_generations SET status='settled',duration_seconds=p_duration,
      video_url=p_video_url,updated_at=now() WHERE request_id=p_request;
  ELSIF p_action='complete' AND r.status='settled' AND r.duration_seconds=p_duration
        AND r.video_url=p_video_url THEN NULL;
  ELSE RAISE EXCEPTION 'avatar_invalid_transition'; END IF;
  SELECT * INTO r FROM public.avatar_owner_generations WHERE request_id=p_request;
  RETURN jsonb_build_object('status',r.status,'video_id',r.video_id,'hold_seconds',r.held_seconds,
    'duration_seconds',r.duration_seconds,'video_url',r.video_url);
END;
$$;

REVOKE ALL ON FUNCTION public.avatar_reservation_period(timestamptz,timestamptz,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.avatar_allowance(bigint,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.avatar_reserve(bigint,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.avatar_transition(bigint,text,text,text,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.avatar_pending(bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.avatar_owner_meter(bigint,text,text,text,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.avatar_reservation_period(timestamptz,timestamptz,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.avatar_allowance(bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.avatar_reserve(bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.avatar_transition(bigint,text,text,text,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.avatar_pending(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.avatar_owner_meter(bigint,text,text,text,integer,text) TO service_role;
COMMIT;