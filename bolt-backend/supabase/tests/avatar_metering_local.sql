CREATE FUNCTION pg_temp.ok(v boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT COALESCE(v,false) THEN RAISE EXCEPTION 'FAILED: %',label; END IF;
RAISE NOTICE 'PASS: %',label; END $$;
INSERT INTO public.entitlements VALUES
(900000001,'monthly','active','paid',now()-interval '1 day',now()-interval '1 day',now()+interval '29 days',now()+interval '29 days'),
(900000002,'yearly','active','paid',now()-interval '35 days',now()-interval '35 days',now()+interval '330 days',now()+interval '330 days'),
(900000003,'seven_day','active','paid',now()-interval '1 day',now()-interval '1 day',now()+interval '6 days',now()+interval '6 days'),
(900000004,'monthly','expired','paid',now()-interval '35 days',now()-interval '35 days',now()-interval '5 days',now()-interval '5 days'),
(900000005,'yearly','expired','paid',now()-interval '365 days',now()-interval '365 days',now()-interval '1 day',now()-interval '1 day');

 SELECT pg_temp.ok((public.avatar_reserve(900000001,'tg:900000001:1001')->>'hold_seconds')::int=30,'monthly holds exactly 30');
SELECT pg_temp.ok((public.avatar_reserve(900000001,'tg:900000001:1001')->>'status')='reserved','duplicate reserve unchanged');
SELECT pg_temp.ok((SELECT count(*)=1 FROM public.avatar_generation_reservations WHERE telegram_user_id=900000001),'one reservation per Telegram update');
DO $$ BEGIN PERFORM public.avatar_transition(900000001,'tg:900000001:1001','failed'); RAISE EXCEPTION 'pre-begin worker released shared hold';
EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'avatar_invalid_transition' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((public.avatar_transition(900000001,'tg:900000001:1001','get')->>'status')='reserved','only winning submitted/failed provider call may release active hold');
SELECT pg_temp.ok((public.avatar_transition(900000001,'tg:900000001:1001','begin')->>'status')='submitting','durable intent before provider');
SELECT pg_temp.ok((public.avatar_transition(900000001,'tg:900000001:1001','job','video_12345678')->>'status')='submitted','job id stored');
 SELECT pg_temp.ok((public.avatar_transition(900000001,'tg:900000001:1001','complete',NULL,12,'https://cdn.example/video.mp4')->>'status')='settled','completed debit');
 SELECT pg_temp.ok((SELECT included_seconds_charged=12 FROM public.avatar_usage_events WHERE request_id='tg:900000001:1001'),'actual 12 seconds, not 30 held, charged');
SELECT pg_temp.ok((SELECT count(*)=1 FROM public.avatar_usage_events WHERE request_id='tg:900000001:1001'),'exactly one debit');
 SELECT pg_temp.ok((public.avatar_transition(900000001,'tg:900000001:1001','complete',NULL,12,'https://cdn.example/video.mp4')->>'status')='settled','duplicate completion idempotent');
SELECT pg_temp.ok((SELECT count(*)=1 FROM public.avatar_usage_events WHERE request_id='tg:900000001:1001'),'no double charge');

-- Fill precisely the 30-minute monthly INCLUDED allowance.
INSERT INTO public.avatar_usage_events(telegram_user_id,request_id,duration_seconds,period_start,period_end,included_seconds_charged,addon_seconds_charged)
 SELECT 900000001,'legacy-month',588,current_period_start,current_period_end,588,0 FROM public.entitlements WHERE telegram_user_id=900000001;
INSERT INTO public.avatar_usage_events(telegram_user_id,request_id,duration_seconds,period_start,period_end,included_seconds_charged,addon_seconds_charged)
SELECT 900000001,'legacy-month-2',600,current_period_start,current_period_end,600,0 FROM public.entitlements WHERE telegram_user_id=900000001;
INSERT INTO public.avatar_usage_events(telegram_user_id,request_id,duration_seconds,period_start,period_end,included_seconds_charged,addon_seconds_charged)
 SELECT 900000001,'legacy-month-3',600,current_period_start,current_period_end,600,0 FROM public.entitlements WHERE telegram_user_id=900000001;
DO $$ BEGIN
 PERFORM public.avatar_reserve(900000001,'tg:900000001:1002');
 RAISE EXCEPTION 'exhausted should fail';
EXCEPTION WHEN OTHERS THEN IF SQLERRM='exhausted should fail' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((SELECT count(*)=0 FROM public.avatar_generation_reservations WHERE request_id='tg:900000001:1002'),'exhausted monthly quota fail closed');

-- A new monthly entitlement period resets the included allowance, not events.
UPDATE public.entitlements SET current_period_start=now()-interval '1 hour',
 current_period_end=now()+interval '29 days', expires_at=now()+interval '29 days'
WHERE telegram_user_id=900000001;
 SELECT pg_temp.ok((public.avatar_reserve(900000001,'tg:900000001:1003')->>'hold_seconds')::int=30,'monthly new period resets included allowance');
SELECT pg_temp.ok((SELECT count(*)=4 FROM public.avatar_usage_events WHERE telegram_user_id=900000001),'old monthly events retained');

 SELECT pg_temp.ok((public.avatar_reserve(900000002,'tg:900000002:2001')->>'hold_seconds')::int=30,'yearly monthly cycle allows a 30-second hold');
 SELECT pg_temp.ok((SELECT held_seconds=30 AND period_start>starts_at FROM public.avatar_generation_reservations r
 JOIN public.entitlements e USING(telegram_user_id) WHERE r.request_id='tg:900000002:2001'),'yearly allowance resets in new month');
 INSERT INTO public.avatar_usage_events(telegram_user_id,request_id,duration_seconds,period_start,period_end,included_seconds_charged,addon_seconds_charged)
 SELECT telegram_user_id,'yearly-used-600',600,period_start,period_end,600,0
 FROM public.avatar_generation_reservations WHERE request_id='tg:900000002:2001';
 INSERT INTO public.avatar_usage_events(telegram_user_id,request_id,duration_seconds,period_start,period_end,included_seconds_charged,addon_seconds_charged)
 SELECT telegram_user_id,'yearly-used-540',540,period_start,period_end,540,0
 FROM public.avatar_generation_reservations WHERE request_id='tg:900000002:2001';
 SELECT pg_temp.ok((public.avatar_allowance(900000002,'tg:900000002:2098')->>'available_seconds')::int=30,'yearly monthly allowance 1200 leaves exactly 30');
 UPDATE public.avatar_usage_events SET duration_seconds=541,included_seconds_charged=541 WHERE request_id='yearly-used-540';
 SELECT pg_temp.ok((public.avatar_allowance(900000002,'tg:900000002:2098')->>'available_seconds')::int=29,'yearly monthly allowance 1200 with 29 remaining');
 DO $$ BEGIN PERFORM public.avatar_reserve(900000002,'tg:900000002:2098'); RAISE EXCEPTION '29 yearly seconds allowed generation';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'avatar_quota_exceeded' THEN RAISE; END IF; END $$;
 UPDATE public.avatar_usage_events SET duration_seconds=540,included_seconds_charged=540 WHERE request_id='yearly-used-540';
DO $$ BEGIN PERFORM public.avatar_reserve(900000003,'tg:900000003:3001'); RAISE EXCEPTION 'seven day allowed';
EXCEPTION WHEN OTHERS THEN IF SQLERRM='seven day allowed' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((SELECT count(*)=0 FROM public.avatar_generation_reservations WHERE telegram_user_id=900000003),'seven-day never reserves');
DO $$ BEGIN PERFORM public.avatar_reserve(900000004,'tg:900000004:4001'); RAISE EXCEPTION 'expired allowed';
EXCEPTION WHEN OTHERS THEN IF SQLERRM='expired allowed' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((SELECT count(*)=0 FROM public.avatar_generation_reservations WHERE telegram_user_id=900000004),'expired monthly plan cannot reserve');
DO $$ BEGIN PERFORM public.avatar_reserve(900000005,'tg:900000005:5001'); RAISE EXCEPTION 'expired yearly allowed';
EXCEPTION WHEN OTHERS THEN IF SQLERRM='expired yearly allowed' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((SELECT count(*)=0 FROM public.avatar_generation_reservations WHERE telegram_user_id=900000005),'expired yearly plan cannot reserve');

 SELECT pg_temp.ok((public.avatar_reserve(900000002,'tg:900000002:2002')->>'hold_seconds')::int=30,'second concurrent hold consumes remaining yearly allowance');
DO $$ BEGIN PERFORM public.avatar_reserve(900000002,'tg:900000002:2003'); RAISE EXCEPTION 'third yearly hold allowed';
EXCEPTION WHEN OTHERS THEN IF SQLERRM='third yearly hold allowed' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((public.avatar_transition(900000002,'tg:900000002:2002','begin')->>'status')='submitting','provider failure reservation started');
SELECT pg_temp.ok((public.avatar_transition(900000002,'tg:900000002:2002','job','video_99999999')->>'status')='submitted','provider failure job stored');
SELECT pg_temp.ok((public.avatar_pending(900000002)->>'request_id')='tg:900000002:2002','restart discovers known submitted job');
DO $$ BEGIN
 PERFORM public.avatar_reserve(900000002,'tg:900000002:2099'); RAISE EXCEPTION 'pending job allowed new generation';
EXCEPTION WHEN OTHERS THEN IF SQLERRM='pending job allowed new generation' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((SELECT count(*)=0 FROM public.avatar_generation_reservations WHERE request_id='tg:900000002:2099'),'known job blocks new paid submission until reconciliation');
SELECT pg_temp.ok((public.avatar_transition(900000002,'tg:900000002:2002','failed')->>'status')='failed','definitive provider failure releases hold');
 SELECT pg_temp.ok((public.avatar_reserve(900000002,'tg:900000002:2003')->>'hold_seconds')::int=30,'released hold reusable');
SELECT pg_temp.ok((public.avatar_transition(900000002,'tg:900000002:2003','begin')->>'status')='submitting','uncertain starts');
SELECT pg_temp.ok((public.avatar_transition(900000002,'tg:900000002:2003','uncertain')->>'status')='uncertain','ambiguous request kept');
SELECT pg_temp.ok((public.avatar_reserve(900000002,'tg:900000002:2003')->>'status')='uncertain','restart cannot replay unknown submit');
SELECT pg_temp.ok((public.avatar_pending(900000002)->>'status')='uncertain','unknown provider submission blocks new work');
 SELECT pg_temp.ok((SELECT count(*)=2 FROM public.avatar_usage_events WHERE telegram_user_id=900000002),'provider failure/uncertain no additional charge');

-- A crash between reserve and begin cannot hold the included quota forever.
INSERT INTO public.entitlements VALUES
(900000010,'monthly','active','paid',now()-interval '1 day',now()-interval '1 day',now()+interval '29 days',now()+interval '29 days');
SELECT pg_temp.ok((public.avatar_reserve(900000010,'tg:900000010:1001')->>'status')='reserved','initial pre-submit claim');
UPDATE public.avatar_generation_reservations SET created_at=now()-interval '6 minutes'
 WHERE request_id='tg:900000010:1001';
 SELECT pg_temp.ok((public.avatar_reserve(900000010,'tg:900000010:1002')->>'hold_seconds')::int=30,'abandoned pre-submit lease reclaimed');
SELECT pg_temp.ok((public.avatar_reserve(900000010,'tg:900000010:1001')->>'status')='failed','replayed stale ID never creates second job');
SELECT pg_temp.ok((public.avatar_transition(900000010,'tg:900000010:1002','begin')->>'status')='submitting','new lease can submit exactly once');
DO $$ BEGIN PERFORM public.avatar_transition(900000010,'tg:900000010:1002','begin'); RAISE EXCEPTION 'duplicate began';
EXCEPTION WHEN OTHERS THEN IF SQLERRM='duplicate began' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((public.avatar_transition(900000010,'tg:900000010:1002','get')->>'status')='submitting','duplicate begin never owns a provider call');

-- Re-activation can move the monthly period before the old end timestamp.
INSERT INTO public.entitlements VALUES
(900000011,'monthly','active','paid',now()-interval '1 day',now()-interval '1 day',now()+interval '29 days',now()+interval '29 days');
SELECT pg_temp.ok((public.avatar_reserve(900000011,'tg:900000011:1101')->>'status')='reserved','previous period hold');
UPDATE public.entitlements SET current_period_start=now()-interval '10 minutes',
 current_period_end=now()+interval '30 days',expires_at=now()+interval '30 days' WHERE telegram_user_id=900000011;
SELECT pg_temp.ok((public.avatar_reserve(900000011,'tg:900000011:1102')->>'status')='reserved','new period can reserve');
SELECT pg_temp.ok((SELECT status='failed' FROM public.avatar_generation_reservations WHERE request_id='tg:900000011:1101'),'previous period pre-submit hold safely released');

-- Changing the period after reserve but before provider submission must fail
-- without even reaching the paid HeyGen call.
INSERT INTO public.entitlements VALUES
(900000012,'monthly','active','paid',now()-interval '1 day',now()-interval '1 day',now()+interval '29 days',now()+interval '29 days');
SELECT pg_temp.ok((public.avatar_reserve(900000012,'tg:900000012:1201')->>'status')='reserved','reserve before rollover');
UPDATE public.entitlements SET current_period_start=now()-interval '5 minutes',
 current_period_end=now()+interval '30 days',expires_at=now()+interval '30 days' WHERE telegram_user_id=900000012;
SELECT pg_temp.ok((public.avatar_transition(900000012,'tg:900000012:1201','begin')->>'status')='failed','begin rejects old monthly period and releases pre-submit hold');

-- NULL/missing entitlement fields must never pass SQL's three-valued logic.
INSERT INTO public.entitlements VALUES
(900000013,'monthly','active',NULL,now()-interval '1 day',now()-interval '1 day',now()+interval '29 days',now()+interval '29 days'),
(900000014,'monthly','active','paid',NULL,now()-interval '1 day',now()+interval '29 days',now()+interval '29 days'),
(900000015,'monthly','active','paid',now()-interval '1 day',NULL,now()+interval '29 days',now()+interval '29 days'),
(900000016,'monthly','active','paid',now()-interval '1 day',now()-interval '1 day',now()+interval '29 days',NULL),
(900000017,'yearly','active','paid',now()-interval '1 day',now()-interval '1 day',now()+interval '364 days',now()+interval '364 days');
DO $$
DECLARE u bigint;
BEGIN
  FOREACH u IN ARRAY ARRAY[900000013::bigint,900000014,900000015,900000016] LOOP
    BEGIN
      PERFORM public.avatar_reserve(u,'tg:'||u||':1111');
      RAISE EXCEPTION 'NULL entitlement passed: %',u;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'NULL entitlement passed:%' THEN RAISE; END IF;
    END;
  END LOOP;
END $$;
SELECT pg_temp.ok((SELECT count(*)=0 FROM public.avatar_generation_reservations
  WHERE telegram_user_id BETWEEN 900000013 AND 900000016),'NULL entitlement fields fail closed');
SELECT pg_temp.ok((public.avatar_reserve(900000017,'tg:900000017:1701')->>'status')='reserved','begin fixture reserved');
UPDATE public.entitlements SET billing_status=NULL WHERE telegram_user_id=900000017;
DO $$ BEGIN PERFORM public.avatar_transition(900000017,'tg:900000017:1701','begin'); RAISE EXCEPTION 'NULL billing began';
EXCEPTION WHEN OTHERS THEN IF SQLERRM='NULL billing began' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((SELECT status='reserved' FROM public.avatar_generation_reservations WHERE request_id='tg:900000017:1701'),'NULL billing blocks begin without paid work');
DELETE FROM public.entitlements WHERE telegram_user_id=900000017;
DO $$ BEGIN PERFORM public.avatar_transition(900000017,'tg:900000017:1701','begin'); RAISE EXCEPTION 'missing entitlement began';
EXCEPTION WHEN OTHERS THEN IF SQLERRM='missing entitlement began' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((SELECT status='reserved' FROM public.avatar_generation_reservations WHERE request_id='tg:900000017:1701'),'missing entitlement blocks begin');

INSERT INTO public.entitlements VALUES
(900000018,'yearly','active','paid',now()-interval '1 day',now()-interval '1 day',now()+interval '364 days',now()+interval '364 days');
SELECT pg_temp.ok((public.avatar_reserve(900000018,'tg:900000018:1801')->>'status')='reserved','yearly begin recheck fixture');
UPDATE public.entitlements SET starts_at=now()+interval '1 day' WHERE telegram_user_id=900000018;
DO $$ BEGIN PERFORM public.avatar_transition(900000018,'tg:900000018:1801','begin'); RAISE EXCEPTION 'future subscription began';
EXCEPTION WHEN OTHERS THEN IF SQLERRM='future subscription began' THEN RAISE; END IF; END $$;
UPDATE public.entitlements SET starts_at=now()-interval '1 day',billing_status='unpaid' WHERE telegram_user_id=900000018;
DO $$ BEGIN PERFORM public.avatar_transition(900000018,'tg:900000018:1801','begin'); RAISE EXCEPTION 'unpaid subscription began';
EXCEPTION WHEN OTHERS THEN IF SQLERRM='unpaid subscription began' THEN RAISE; END IF; END $$;
UPDATE public.entitlements SET billing_status='paid',status='expired' WHERE telegram_user_id=900000018;
DO $$ BEGIN PERFORM public.avatar_transition(900000018,'tg:900000018:1801','begin'); RAISE EXCEPTION 'expired status began';
EXCEPTION WHEN OTHERS THEN IF SQLERRM='expired status began' THEN RAISE; END IF; END $$;
UPDATE public.entitlements SET status='active',plan_id='seven_day' WHERE telegram_user_id=900000018;
DO $$ BEGIN PERFORM public.avatar_transition(900000018,'tg:900000018:1801','begin'); RAISE EXCEPTION 'seven-day began';
EXCEPTION WHEN OTHERS THEN IF SQLERRM='seven-day began' THEN RAISE; END IF; END $$;
UPDATE public.entitlements SET plan_id='yearly',current_period_start=NULL WHERE telegram_user_id=900000018;
DO $$ BEGIN PERFORM public.avatar_transition(900000018,'tg:900000018:1801','begin'); RAISE EXCEPTION 'missing annual period began';
EXCEPTION WHEN OTHERS THEN IF SQLERRM='missing annual period began' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((SELECT status='reserved' FROM public.avatar_generation_reservations WHERE request_id='tg:900000018:1801'),'all revoked begin checks leave provider untouched');

-- Text-to-video reserves exactly 30, never an arbitrary client-supplied hold.
-- Even 29 remaining included seconds cannot reach a paid provider call.
INSERT INTO public.entitlements VALUES
(900000019,'monthly','active','paid',now()-interval '1 day',now()-interval '1 day',now()+interval '29 days',now()+interval '29 days');
INSERT INTO public.avatar_usage_events(telegram_user_id,request_id,duration_seconds,period_start,period_end,included_seconds_charged,addon_seconds_charged)
 SELECT telegram_user_id,'legacy-included-600a',600,current_period_start,current_period_end,600,0
 FROM public.entitlements WHERE telegram_user_id=900000019;
INSERT INTO public.avatar_usage_events(telegram_user_id,request_id,duration_seconds,period_start,period_end,included_seconds_charged,addon_seconds_charged)
 SELECT telegram_user_id,'legacy-included-600b',600,current_period_start,current_period_end,600,0
 FROM public.entitlements WHERE telegram_user_id=900000019;
INSERT INTO public.avatar_usage_events(telegram_user_id,request_id,duration_seconds,period_start,period_end,included_seconds_charged,addon_seconds_charged)
 SELECT telegram_user_id,'legacy-included-571',571,current_period_start,current_period_end,571,0
 FROM public.entitlements WHERE telegram_user_id=900000019;
SELECT pg_temp.ok((public.avatar_allowance(900000019,'tg:900000019:1901')->>'available_seconds')::int=29,'preflight reports 29 remaining included seconds');
DO $$ BEGIN PERFORM public.avatar_reserve(900000019,'tg:900000019:1901'); RAISE EXCEPTION '29 seconds allowed paid video';
EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'avatar_quota_exceeded' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((SELECT count(*)=0 FROM public.avatar_generation_reservations WHERE telegram_user_id=900000019),'29 remaining cannot reserve even a short video');
UPDATE public.avatar_usage_events SET duration_seconds=570,included_seconds_charged=570 WHERE request_id='legacy-included-571';
SELECT pg_temp.ok((public.avatar_allowance(900000019,'tg:900000019:1901')->>'available_seconds')::int=30,'preflight reports exactly 30 remaining included seconds');
SELECT pg_temp.ok((public.avatar_reserve(900000019,'tg:900000019:1901')->>'hold_seconds')::int=30,'server sets fixed 30-second hold');
SELECT pg_temp.ok((public.avatar_allowance(900000019,'tg:900000019:1902')->>'available_seconds')::int=0,'concurrent request sees all 30 held');
DO $$ BEGIN PERFORM public.avatar_reserve(900000019,'tg:900000019:1902'); RAISE EXCEPTION 'concurrent hold over allowance';
EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'avatar_quota_exceeded' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((public.avatar_transition(900000019,'tg:900000019:1901','begin')->>'status')='submitting','30-second hold begins');
SELECT pg_temp.ok((public.avatar_transition(900000019,'tg:900000019:1901','job','video_19000001')->>'status')='submitted','30-second job saved');
DO $$ BEGIN PERFORM public.avatar_transition(900000019,'tg:900000019:1901','complete',NULL,31,'https://cdn.example/video.mp4'); RAISE EXCEPTION '31-second video settled';
EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'avatar_invalid_transition' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((public.avatar_transition(900000019,'tg:900000019:1901','get')->>'status')='submitted','over-30 video remains quarantined');
SELECT pg_temp.ok((public.avatar_transition(900000019,'tg:900000019:1901','complete',NULL,12,'https://cdn.example/video.mp4')->>'status')='settled','12 actual seconds charged, 18 seconds released');
SELECT pg_temp.ok((SELECT included_seconds_charged=12 AND addon_seconds_charged=0
 FROM public.avatar_usage_events WHERE request_id='tg:900000019:1901'),'completed debit is included-only');
SELECT pg_temp.ok((public.avatar_allowance(900000019,'tg:900000019:1903')->>'available_seconds')::int=18,'unused hold released after actual 12-second settlement');
DO $$ BEGIN PERFORM public.avatar_reserve(900000019,'tg:900000019:1904',1); RAISE EXCEPTION 'client-supplied hold accepted';
EXCEPTION WHEN OTHERS THEN IF SQLERRM='client-supplied hold accepted' THEN RAISE; END IF; END $$;

-- Edge dispatch alone selects the service-role-only owner RPC by its trusted
-- OWNER_TELEGRAM_ID; SQL has no owner flag or faux customer subscription.
INSERT INTO public.entitlements VALUES
(900000020,'seven_day','active','paid',now()-interval '1 day',now()-interval '1 day',now()+interval '6 days',now()+interval '6 days');
SELECT pg_temp.ok((public.avatar_owner_meter(900000020,'tg:900000020:20001','allowance')->>'available_seconds')::int=30,
  'owner is eligible despite seven-day customer plan');
SELECT pg_temp.ok((public.avatar_owner_meter(900000020,'tg:900000020:20001','reserve')->>'hold_seconds')::int=30,
  'owner has separate 30-second safety hold without customer period');
SELECT pg_temp.ok((SELECT count(*)=0 FROM public.avatar_generation_reservations WHERE telegram_user_id=900000020),
  'owner holds never enter customer reservation scope');
DO $$ BEGIN PERFORM public.avatar_owner_meter(900000020,'tg:900000020:20001','failed'); RAISE EXCEPTION 'pre-begin release allowed';
EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'avatar_invalid_transition' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((public.avatar_owner_meter(900000020,'tg:900000020:20001','begin')->>'status')='submitting',
  'owner begin acquires single provider submission');
DO $$ BEGIN PERFORM public.avatar_owner_meter(900000020,'tg:900000020:20001','begin'); RAISE EXCEPTION 'owner duplicate provider submission';
EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'avatar_invalid_transition' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((public.avatar_owner_meter(900000020,'tg:900000020:20001','job','video_own20001')->>'status')='submitted',
  'owner durable job ID saved');
SELECT pg_temp.ok((public.avatar_owner_meter(900000020,'tg:900000020:20001','pending')->>'status')='submitted',
  'owner submitted job can resume after process restart');
SELECT pg_temp.ok((public.avatar_pending(900000020)->>'status')='uncertain',
  'changed server owner configuration does not forget an owner job');
DO $$ BEGIN PERFORM public.avatar_reserve(900000020,'tg:900000020:20003'); RAISE EXCEPTION 'customer path ignored owner job';
EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'avatar_pending_reconciliation' THEN RAISE; END IF; END $$;
DO $$ BEGIN PERFORM public.avatar_owner_meter(900000020,'tg:900000020:20002','reserve'); RAISE EXCEPTION 'owner pending ignored';
EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'avatar_pending_reconciliation' THEN RAISE; END IF; END $$;
DO $$ BEGIN PERFORM public.avatar_owner_meter(900000020,'tg:900000020:20001','complete',NULL,31,'https://cdn.example/owner.mp4'); RAISE EXCEPTION 'owner over-30 accepted';
EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'avatar_invalid_transition' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((public.avatar_owner_meter(900000020,'tg:900000020:20001','complete',NULL,12,'https://cdn.example/owner.mp4')->>'status')='settled',
  'owner settles actual 12 seconds without customer ledger');
SELECT pg_temp.ok((public.avatar_owner_meter(900000020,'tg:900000020:20001','complete',NULL,12,'https://cdn.example/owner.mp4')->>'status')='settled',
  'owner completion is idempotent');
SELECT pg_temp.ok((SELECT count(*)=0 FROM public.avatar_usage_events WHERE telegram_user_id=900000020),
  'owner has no customer included or add-on debit');
SELECT pg_temp.ok((public.avatar_owner_meter(900000020,'tg:900000020:20001','reserve')->>'status')='settled',
  'owner duplicate request cannot generate twice');
UPDATE public.entitlements SET status='expired',expires_at=now()-interval '1 minute',
  current_period_end=now()-interval '1 minute' WHERE telegram_user_id=900000020;
DO $$ BEGIN PERFORM public.avatar_reserve(900000020,'tg:900000020:20004'); RAISE EXCEPTION 'seven-day customer granted reserve';
EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'avatar_plan_inactive' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok((public.avatar_owner_meter(900000020,'tg:900000020:20002','reserve')->>'status')='reserved',
  'owner not subject to customer expiry or 30/20-minute allowance');
SELECT pg_temp.ok((public.avatar_owner_meter(900000020,'tg:900000020:20002','begin')->>'status')='submitting',
  'expired-plan owner keeps durable begin CAS');
SELECT pg_temp.ok((public.avatar_owner_meter(900000020,'tg:900000020:20002','uncertain')->>'status')='uncertain',
  'ambiguous owner provider submission stays held');
SELECT pg_temp.ok((public.avatar_owner_meter(900000020,'tg:900000020:20002','pending')->>'status')='uncertain',
  'owner unknown provider outcome survives restart');
DO $$ BEGIN PERFORM public.avatar_owner_meter(900000020,'tg:900000020:20005','reserve'); RAISE EXCEPTION 'owner unknown provider outcome ignored';
EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'avatar_pending_reconciliation' THEN RAISE; END IF; END $$;
DO $$ BEGIN PERFORM public.avatar_owner_meter(900000020,'tg:900000021:20003','reserve'); RAISE EXCEPTION 'owner forged request prefix';
EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'invalid_avatar_request' THEN RAISE; END IF; END $$;
SELECT pg_temp.ok(NOT has_function_privilege('anon','public.avatar_owner_meter(bigint,text,text,text,integer,text)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.avatar_owner_meter(bigint,text,text,text,integer,text)','EXECUTE'),
  'public and customer roles cannot invoke owner RPC');
SELECT pg_temp.ok(NOT has_table_privilege('authenticated','public.avatar_owner_generations','INSERT'),
  'customer role cannot write owner records');

-- A configured owner whose former customer plan used all 1,800 seconds still
-- uses ONLY the owner scope: no new charge against that customer history.
INSERT INTO public.entitlements VALUES
(900000021,'monthly','active','paid',now()-interval '1 day',now()-interval '1 day',now()+interval '29 days',now()+interval '29 days');
INSERT INTO public.avatar_usage_events(telegram_user_id,request_id,duration_seconds,period_start,period_end,included_seconds_charged,addon_seconds_charged)
 SELECT telegram_user_id,'owner-old-customer-'||n,600,current_period_start,current_period_end,600,0
 FROM public.entitlements CROSS JOIN generate_series(1,3) n WHERE telegram_user_id=900000021;
SELECT pg_temp.ok((public.avatar_allowance(900000021,'tg:900000021:21001')->>'available_seconds')::int=0,
  'monthly customer quota is exhausted');
SELECT pg_temp.ok((public.avatar_owner_meter(900000021,'tg:900000021:21001','reserve')->>'status')='reserved',
  'trusted owner route is not blocked by exhausted customer quota');
SELECT pg_temp.ok((public.avatar_owner_meter(900000021,'tg:900000021:21001','begin')->>'status')='submitting',
  'owner exhausted customer quota still begins once');
SELECT pg_temp.ok((public.avatar_owner_meter(900000021,'tg:900000021:21001','failed')->>'status')='failed',
  'definite provider rejection releases only winning owner hold');
SELECT pg_temp.ok((public.avatar_owner_meter(900000021,'tg:900000021:21001','reserve')->>'status')='failed',
  'replayed definite failure cannot regenerate same owner request');
SELECT pg_temp.ok((SELECT sum(included_seconds_charged)=1800 AND sum(addon_seconds_charged)=0
 FROM public.avatar_usage_events WHERE telegram_user_id=900000021),
  'owner reservation cannot spend customer allowance or add-ons');