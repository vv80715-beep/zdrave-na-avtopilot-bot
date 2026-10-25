-- These fixtures exist ONLY in the disposable socket-only test database.
CREATE FUNCTION pg_temp.ok(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT COALESCE(v,false) THEN RAISE EXCEPTION 'FAILED: %',label; END IF;
RAISE NOTICE 'PASS: %',label; END $$;
CREATE FUNCTION pg_temp.reject(q text,expected text,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE q; EXCEPTION WHEN OTHERS THEN
    IF SQLERRM<>expected THEN RAISE; END IF;
    RAISE NOTICE 'PASS: %',label; RETURN;
  END;
  RAISE EXCEPTION 'FAILED: % (accepted)',label;
END $$;
CREATE FUNCTION pg_temp.seed(u bigint,remaining integer,addon integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s timestamptz:=now()-interval '1 day'; e timestamptz:=now()+interval '29 days';
  used integer:=1800-remaining; n integer:=0; chunk integer;
BEGIN
  INSERT INTO public.entitlements VALUES(u,'monthly','active','paid',s,s,e,e);
  INSERT INTO public.avatar_addon_balances(telegram_user_id,purchased_seconds) VALUES(u,addon);
  WHILE used>0 LOOP
    chunk:=LEAST(used,600); n:=n+1;
    INSERT INTO public.avatar_usage_events
      (telegram_user_id,request_id,duration_seconds,period_start,period_end,included_seconds_charged,addon_seconds_charged)
      VALUES(u,'seed-'||u||'-'||n,chunk,s,e,chunk,0);
    used:=used-chunk;
  END LOOP;
END $$;
CREATE FUNCTION pg_temp.submit(u bigint,req text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.avatar_reserve(u,req);
  PERFORM public.avatar_transition(u,req,'begin');
  PERFORM public.avatar_transition(u,req,'job','video_test_1234');
END $$;
CREATE FUNCTION pg_temp.record(u bigint,req text,d integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e public.entitlements%ROWTYPE;
BEGIN
  SELECT * INTO e FROM public.entitlements WHERE telegram_user_id=u;
  PERFORM public.record_avatar_usage(u,req,d,e.current_period_start,e.current_period_end,1800);
END $$;

SELECT pg_temp.seed(910000001,30,0);
SELECT pg_temp.submit(910000001,'tg:910000001:1');
SELECT public.avatar_transition(910000001,'tg:910000001:1','complete',NULL,12,'https://cdn.example/1.mp4');
SELECT pg_temp.ok((SELECT included_seconds_charged=12 AND addon_seconds_charged=0
  FROM public.avatar_usage_events WHERE request_id='tg:910000001:1'),'included-only actual 12 releases 18');

SELECT pg_temp.seed(910000002,0,60);
SELECT pg_temp.submit(910000002,'tg:910000002:1');
SELECT public.avatar_transition(910000002,'tg:910000002:1','complete',NULL,12,'https://cdn.example/2.mp4');
SELECT pg_temp.ok((SELECT used_seconds=12 FROM public.avatar_addon_balances WHERE telegram_user_id=910000002),
  'addon-only debit uses actual duration');
SELECT pg_temp.ok((public.avatar_allowance(910000002,'tg:910000002:2')->>'available_seconds')::bigint=48,
  'unused addon hold released');
SELECT public.avatar_transition(910000002,'tg:910000002:1','complete',NULL,12,'https://cdn.example/2.mp4');
SELECT pg_temp.record(910000002,'tg:910000002:1',12);
SELECT pg_temp.ok((SELECT used_seconds=12 FROM public.avatar_addon_balances WHERE telegram_user_id=910000002)
  AND (SELECT count(*)=1 FROM public.avatar_usage_events WHERE request_id='tg:910000002:1'),
  'duplicate transition and direct RPC do not double debit');
SELECT pg_temp.reject($q$SELECT pg_temp.record(910000002,'tg:910000002:1',13)$q$,
  'avatar_request_id_conflict','changed duration duplicate rejected');

SELECT pg_temp.seed(910000003,10,20);
SELECT public.avatar_reserve(910000003,'tg:910000003:1');
SELECT pg_temp.ok((SELECT held_included_seconds=10 AND held_addon_seconds=20
  FROM public.avatar_generation_reservations WHERE request_id='tg:910000003:1'),'10 included plus 20 addon fixed hold');
SELECT pg_temp.ok((public.avatar_allowance(910000003,'tg:910000003:2')->>'available_seconds')::bigint=0,
  'both funding sources held before submission');
SELECT pg_temp.reject($q$SELECT pg_temp.record(910000003,'direct-held-3',1)$q$,
  'avatar_quota_exceeded','direct recorder cannot consume included or addon held funds');
SELECT pg_temp.reject($q$SELECT pg_temp.record(910000003,'tg:910000003:1',1)$q$,
  'avatar_request_id_conflict','direct recorder cannot impersonate completion');
SELECT public.avatar_transition(910000003,'tg:910000003:1','begin');
SELECT public.avatar_transition(910000003,'tg:910000003:1','job','video_test_1234');
SELECT public.avatar_transition(910000003,'tg:910000003:1','complete',NULL,12,'https://cdn.example/3.mp4');
SELECT pg_temp.ok((SELECT included_seconds_charged=10 AND addon_seconds_charged=2
  FROM public.avatar_usage_events WHERE request_id='tg:910000003:1'),'split completion charges included first');
SELECT pg_temp.ok((public.avatar_allowance(910000003,'tg:910000003:2')->>'available_seconds')::bigint=18,
  'split unused hold returns 18 addon seconds');

SELECT pg_temp.seed(910000004,10,19);
SELECT pg_temp.reject($q$SELECT public.avatar_reserve(910000004,'tg:910000004:1')$q$,
  'avatar_quota_exceeded','29 total seconds cannot reserve');
SELECT pg_temp.seed(910000005,0,5000);
SELECT pg_temp.ok((public.avatar_allowance(910000005,'tg:910000005:1')->>'available_seconds')::bigint=5000,
  'addon allowance over 1800 is available');
SELECT pg_temp.submit(910000005,'tg:910000005:1');
SELECT pg_temp.reject($q$SELECT public.avatar_transition(910000005,'tg:910000005:1','complete',NULL,31,'https://cdn.example/5.mp4')$q$,
  'avatar_invalid_transition','over-30 duration remains quarantined');
SELECT pg_temp.ok((SELECT status='submitted' AND held_addon_seconds=30
  FROM public.avatar_generation_reservations WHERE request_id='tg:910000005:1')
  AND (SELECT used_seconds=0 FROM public.avatar_addon_balances WHERE telegram_user_id=910000005),
  'quarantine retains hold without ledger debit');
SELECT pg_temp.reject($q$SELECT public.avatar_reserve(910000005,'tg:910000005:2')$q$,
  'avatar_pending_reconciliation','pending job blocks new work despite large addon');
SELECT public.avatar_transition(910000005,'tg:910000005:1','failed');
SELECT pg_temp.ok((public.avatar_allowance(910000005,'tg:910000005:2')->>'available_seconds')::bigint=5000,
  'definitive failed job releases addon hold without charge');

SELECT pg_temp.seed(910000006,0,60);
SELECT public.avatar_reserve(910000006,'tg:910000006:1');
SELECT public.avatar_transition(910000006,'tg:910000006:1','begin');
SELECT public.avatar_transition(910000006,'tg:910000006:1','uncertain');
UPDATE public.avatar_generation_reservations SET created_at=now()-interval '40 days',
  period_start=now()-interval '40 days',period_end=now()-interval '10 days'
  WHERE request_id='tg:910000006:1';
SELECT pg_temp.ok((SELECT addon_available=30 FROM public.avatar_available_funds(
  910000006,now()-interval '1 day',now()+interval '29 days',1800)),
  'uncertain prior-period addon hold stays globally reserved');
SELECT pg_temp.reject($q$SELECT public.avatar_reserve(910000006,'tg:910000006:2')$q$,
  'avatar_pending_reconciliation','uncertain never auto-released across periods');
SELECT pg_temp.reject($q$SELECT public.avatar_transition(910000006,'tg:910000006:1','failed')$q$,
  'avatar_invalid_transition','uncertain cannot be blindly failed');
SELECT pg_temp.reject($q$SELECT pg_temp.record(910000006,'direct-past-held',31)$q$,
  'avatar_quota_exceeded','direct current-period usage respects prior-period global hold');
SELECT pg_temp.record(910000006,'direct-free-only',30);
SELECT pg_temp.ok((SELECT used_seconds=30 FROM public.avatar_addon_balances WHERE telegram_user_id=910000006),
  'direct recorder can spend unheld funds only');

SELECT pg_temp.seed(910000007,0,30);
SELECT public.avatar_reserve(910000007,'tg:910000007:1');
UPDATE public.avatar_generation_reservations SET created_at=now()-interval '6 minutes'
  WHERE request_id='tg:910000007:1';
SELECT pg_temp.ok((public.avatar_reserve(910000007,'tg:910000007:2')->>'status')='reserved',
  'unsubmitted expired addon lease can be reclaimed');
SELECT pg_temp.ok((public.avatar_reserve(910000007,'tg:910000007:1')->>'status')='failed',
  'expired request cannot generate twice');

SELECT pg_temp.seed(910000008,10,20);
SELECT pg_temp.submit(910000008,'tg:910000008:1');
UPDATE public.entitlements SET status='expired',expires_at=now()-interval '1 second' WHERE telegram_user_id=910000008;
SELECT public.avatar_transition(910000008,'tg:910000008:1','complete',NULL,30,'https://cdn.example/8.mp4');
SELECT pg_temp.ok((SELECT included_seconds_charged=10 AND addon_seconds_charged=20
  FROM public.avatar_usage_events WHERE request_id='tg:910000008:1'),
  'full split hold settles original period after plan expiry');

SELECT pg_temp.seed(910000009,0,5000);
UPDATE public.entitlements SET plan_id='seven_day' WHERE telegram_user_id=910000009;
SELECT pg_temp.reject($q$SELECT public.avatar_reserve(910000009,'tg:910000009:1')$q$,
  'avatar_plan_inactive','addon does not authorize blocked customer plan');
SELECT public.avatar_owner_meter(910000009,'tg:910000009:1','reserve');
SELECT public.avatar_owner_meter(910000009,'tg:910000009:1','begin');
SELECT public.avatar_owner_meter(910000009,'tg:910000009:1','job','video_owner_1234');
SELECT public.avatar_owner_meter(910000009,'tg:910000009:1','complete',NULL,12,'https://cdn.example/owner.mp4');
SELECT pg_temp.ok((SELECT used_seconds=0 FROM public.avatar_addon_balances WHERE telegram_user_id=910000009)
  AND NOT EXISTS(SELECT 1 FROM public.avatar_usage_events WHERE request_id='tg:910000009:1'),
  'trusted owner does not spend customer addon balance');
SELECT pg_temp.reject($q$SELECT pg_temp.record(910000009,'tg:910000009:1',12)$q$,
  'avatar_request_id_conflict','owner record cannot enter customer ledger');
SELECT pg_temp.reject($q$SELECT public.avatar_reserve(910000009,'tg:910000009:1')$q$,
  'avatar_request_conflict','customer cannot reuse owner request');
SELECT pg_temp.ok(NOT has_function_privilege('authenticated',
  'public.record_avatar_usage(bigint,text,integer,timestamptz,timestamptz,integer)','EXECUTE')
  AND NOT has_function_privilege('anon',
  'public.avatar_available_funds(bigint,timestamptz,timestamptz,integer)','EXECUTE'),
  'customer and public roles cannot bypass trusted metering');

SELECT pg_temp.seed(910000010,0,30);
SELECT pg_temp.submit(910000010,'tg:910000010:1');
-- Simulate operator balance corruption; completion must roll back atomically.
UPDATE public.avatar_addon_balances SET used_seconds=30 WHERE telegram_user_id=910000010;
SELECT pg_temp.reject($q$SELECT public.avatar_transition(910000010,'tg:910000010:1','complete',NULL,12,'https://cdn.example/10.mp4')$q$,
  'avatar_quota_exceeded','failed settlement fails closed');
SELECT pg_temp.ok((SELECT status='submitted' FROM public.avatar_generation_reservations WHERE request_id='tg:910000010:1')
  AND NOT EXISTS(SELECT 1 FROM public.avatar_usage_events WHERE request_id='tg:910000010:1'),
  'failed settlement restores hold and leaves ledger unchanged');

SELECT pg_temp.seed(910000011,60,0);
SELECT public.avatar_reserve(910000011,'tg:910000011:1');
SELECT pg_temp.record(910000011,'direct-included-free',30);
SELECT pg_temp.reject($q$SELECT pg_temp.record(910000011,'direct-included-held',1)$q$,
  'avatar_quota_exceeded','direct recorder preserves included-only hold');
SELECT public.avatar_transition(910000011,'tg:910000011:1','begin');
SELECT public.avatar_transition(910000011,'tg:910000011:1','job','video_test_1234');
SELECT public.avatar_transition(910000011,'tg:910000011:1','complete',NULL,30,'https://cdn.example/11.mp4');
SELECT pg_temp.ok((SELECT included_seconds_charged=30 FROM public.avatar_usage_events WHERE request_id='tg:910000011:1'),
  'protected included reservation still settles after direct usage');

SELECT pg_temp.seed(910000012,40,20);
SELECT public.avatar_reserve(910000012,'tg:910000012:1');
SELECT public.avatar_reserve(910000012,'tg:910000012:2');
SELECT public.avatar_transition(910000012,'tg:910000012:2','begin');
SELECT public.avatar_transition(910000012,'tg:910000012:2','job','video_test_1234');
SELECT public.avatar_transition(910000012,'tg:910000012:2','complete',NULL,12,'https://cdn.example/12.mp4');
SELECT pg_temp.ok((SELECT included_seconds_charged=10 AND addon_seconds_charged=2
  FROM public.avatar_usage_events WHERE request_id='tg:910000012:2'),
  'out-of-order settlement cannot steal another reservation included funding');
SELECT public.avatar_transition(910000012,'tg:910000012:1','begin');
SELECT public.avatar_transition(910000012,'tg:910000012:1','job','video_test_1235');
SELECT public.avatar_transition(910000012,'tg:910000012:1','complete',NULL,30,'https://cdn.example/12a.mp4');
SELECT pg_temp.ok((SELECT used_seconds=2 FROM public.avatar_addon_balances WHERE telegram_user_id=910000012),
  'both differently funded reservations settle without overdraw');

SELECT pg_temp.seed(910000013,0,30);
UPDATE public.entitlements SET plan_id='yearly',starts_at=now()-interval '35 days',
  expires_at=now()+interval '330 days',current_period_end=now()+interval '330 days'
  WHERE telegram_user_id=910000013;
DELETE FROM public.avatar_usage_events WHERE telegram_user_id=910000013;
INSERT INTO public.avatar_usage_events
  (telegram_user_id,request_id,duration_seconds,period_start,period_end,included_seconds_charged,addon_seconds_charged)
  SELECT e.telegram_user_id,'yearly-addon-seed-'||n,600,p.period_start,p.period_end,600,0
  FROM public.entitlements e
  CROSS JOIN LATERAL public.avatar_reservation_period(e.starts_at,e.expires_at,true) p
  CROSS JOIN generate_series(1,2) n WHERE e.telegram_user_id=910000013;
SELECT pg_temp.submit(910000013,'tg:910000013:1');
SELECT public.avatar_transition(910000013,'tg:910000013:1','complete',NULL,12,'https://cdn.example/13.mp4');
SELECT pg_temp.ok((SELECT included_seconds_charged=0 AND addon_seconds_charged=12
  FROM public.avatar_usage_events WHERE request_id='tg:910000013:1'),
  'yearly monthly-cycle exhausted included allowance uses addon');
UPDATE public.entitlements SET billing_status='past_due' WHERE telegram_user_id=910000013;
SELECT pg_temp.reject($q$SELECT public.avatar_reserve(910000013,'tg:910000013:2')$q$,
  'avatar_plan_inactive','purchased seconds do not bypass billing gate');

SELECT pg_temp.seed(910000050,0,30);
SELECT pg_temp.seed(910000051,0,30);
SELECT pg_temp.seed(910000052,0,30);
SELECT pg_temp.submit(910000052,'tg:910000052:1');