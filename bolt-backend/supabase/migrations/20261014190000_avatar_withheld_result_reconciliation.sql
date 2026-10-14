BEGIN;

-- A confirmed HeyGen render that exceeds the 20-second delivery cap is neither
-- a customer usage charge nor an unresolved hold. Keep its provider job ID and
-- factual rendered duration, close the hold, and record no avatar_usage_event.
-- HeyGen's status response does not expose a verified monetary provider cost;
-- do not infer or persist one from duration.
ALTER TABLE public.avatar_generation_reservations
  DROP CONSTRAINT avatar_generation_reservations_status_check,
  ADD CONSTRAINT avatar_generation_reservations_status_check
    CHECK (status IN ('reserved','submitting','submitted','settled','withheld','failed','uncertain'));

ALTER TABLE public.avatar_owner_generations
  DROP CONSTRAINT avatar_owner_generations_status_check,
  ADD CONSTRAINT avatar_owner_generations_status_check
    CHECK (status IN ('reserved','submitting','submitted','settled','withheld','failed','uncertain')),
  DROP CONSTRAINT avatar_owner_generations_duration_seconds_check,
  ADD CONSTRAINT avatar_owner_generations_duration_seconds_check
    CHECK (duration_seconds BETWEEN 1 AND 600);

CREATE FUNCTION public.avatar_withhold(
  p_user bigint,p_request text,p_video_id text,p_duration integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.avatar_generation_reservations%ROWTYPE;
BEGIN
  IF p_user IS NULL OR p_user<=0 OR p_request IS NULL
     OR p_request !~ ('^tg:' || p_user::text || ':[1-9][0-9]{0,18}$')
     OR p_video_id IS NULL OR p_video_id !~ '^[A-Za-z0-9_-]{8,200}$'
     OR p_duration IS NULL OR p_duration NOT BETWEEN 21 AND 600
    THEN RAISE EXCEPTION 'invalid_avatar_withheld_result'; END IF;

  -- Match the existing ledger writer's lock order to serialize against both
  -- allowance reservations and direct/add-on usage recording.
  PERFORM 1 FROM public.entitlements WHERE telegram_user_id=p_user FOR UPDATE;
  PERFORM pg_advisory_xact_lock(p_user);
  SELECT * INTO r FROM public.avatar_generation_reservations
    WHERE request_id=p_request FOR UPDATE;
  IF NOT FOUND OR r.telegram_user_id<>p_user
    THEN RAISE EXCEPTION 'avatar_request_not_found'; END IF;

  IF r.status='submitted' AND r.video_id=p_video_id THEN
    IF EXISTS (SELECT 1 FROM public.avatar_usage_events WHERE request_id=p_request)
      THEN RAISE EXCEPTION 'avatar_request_id_conflict'; END IF;
    UPDATE public.avatar_generation_reservations
      SET status='withheld',duration_seconds=p_duration,video_url=NULL,updated_at=now()
      WHERE request_id=p_request;
  ELSIF r.status='withheld' AND r.video_id=p_video_id
        AND r.duration_seconds=p_duration AND r.video_url IS NULL THEN
    -- Safe replay after an RPC timeout, webhook duplicate, or process restart.
    NULL;
  ELSE
    RAISE EXCEPTION 'avatar_invalid_transition';
  END IF;

  SELECT * INTO r FROM public.avatar_generation_reservations WHERE request_id=p_request;
  RETURN jsonb_build_object('status',r.status,'video_id',r.video_id,
    'hold_seconds',r.held_seconds,'duration_seconds',r.duration_seconds,'video_url',NULL);
END;
$$;

CREATE FUNCTION public.avatar_owner_withhold(
  p_user bigint,p_request text,p_video_id text,p_duration integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.avatar_owner_generations%ROWTYPE;
BEGIN
  IF p_user IS NULL OR p_user<=0 OR p_request IS NULL
     OR p_request !~ ('^tg:' || p_user::text || ':[1-9][0-9]{0,18}$')
     OR p_video_id IS NULL OR p_video_id !~ '^[A-Za-z0-9_-]{8,200}$'
     OR p_duration IS NULL OR p_duration NOT BETWEEN 21 AND 600
    THEN RAISE EXCEPTION 'invalid_avatar_withheld_result'; END IF;

  PERFORM pg_advisory_xact_lock(p_user);
  IF EXISTS (SELECT 1 FROM public.avatar_generation_reservations WHERE request_id=p_request)
    THEN RAISE EXCEPTION 'avatar_request_conflict'; END IF;
  SELECT * INTO r FROM public.avatar_owner_generations
    WHERE request_id=p_request FOR UPDATE;
  IF NOT FOUND OR r.telegram_user_id<>p_user
    THEN RAISE EXCEPTION 'avatar_request_not_found'; END IF;

  IF r.status='submitted' AND r.video_id=p_video_id THEN
    UPDATE public.avatar_owner_generations
      SET status='withheld',duration_seconds=p_duration,video_url=NULL,updated_at=now()
      WHERE request_id=p_request;
  ELSIF r.status='withheld' AND r.video_id=p_video_id
        AND r.duration_seconds=p_duration AND r.video_url IS NULL THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'avatar_invalid_transition';
  END IF;

  SELECT * INTO r FROM public.avatar_owner_generations WHERE request_id=p_request;
  RETURN jsonb_build_object('status',r.status,'video_id',r.video_id,
    'hold_seconds',r.held_seconds,'duration_seconds',r.duration_seconds,'video_url',NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.avatar_withhold(bigint,text,text,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.avatar_owner_withhold(bigint,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.avatar_withhold(bigint,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.avatar_owner_withhold(bigint,text,text,integer) TO service_role;

COMMIT;
