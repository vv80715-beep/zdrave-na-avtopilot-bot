\set ON_ERROR_STOP on
-- Everything here runs ONLY in the disposable socket-only PostgreSQL cluster.
CREATE FUNCTION pg_temp.check(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
 RAISE NOTICE 'PASS: %', label;
END $$;

SELECT pg_temp.check((SELECT count(*) = 0 FROM payment_notification_outbox), 'migration enqueues no historical purchases');
SELECT * FROM credit_avatar_addon_purchase('aaaaaaaa-aaaa-4aaa-8aaa-000000000001','cs_historical','','evt_retry_historical');
SELECT pg_temp.check((SELECT count(*) = 0 FROM payment_notification_outbox), 'historical duplicate never backfills');

-- A purchase for each package, plus concurrent credit/claim targets.
INSERT INTO avatar_addon_purchases(id,user_id,telegram_user_id,package_id,minutes,seconds,status,stripe_checkout_session_id)
SELECT ('bbbbbbbb-bbbb-4bbb-8bbb-' || lpad(n::text,12,'0'))::uuid,
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',990000000+n,'addon_' || minutes,minutes,minutes*60,'checkout_created','cs_local_' || n
FROM (VALUES (2,20),(3,50),(4,100),(5,200),(6,20),(7,20),(8,20),(9,20)) AS v(n,minutes);

SELECT * FROM credit_avatar_addon_purchase('bbbbbbbb-bbbb-4bbb-8bbb-000000000002','cs_local_2','pi_local_2','evt_local_2');
SELECT * FROM credit_avatar_addon_purchase('bbbbbbbb-bbbb-4bbb-8bbb-000000000002','cs_local_2','pi_local_2','evt_local_2_retry');
SELECT pg_temp.check((SELECT purchased_seconds=1200 FROM avatar_addon_balances WHERE telegram_user_id=990000002), 'duplicate credit does not double balance');
SELECT pg_temp.check((SELECT count(*)=1 FROM payment_notification_outbox WHERE addon_purchase_id='bbbbbbbb-bbbb-4bbb-8bbb-000000000002'), 'duplicate credit has one durable notice');
SELECT pg_temp.check((SELECT (claim_payment_notification(id)->>'status')='sending' FROM payment_notification_outbox WHERE addon_purchase_id='bbbbbbbb-bbbb-4bbb-8bbb-000000000002'), 'paid credited purchase claims without requiring subscription');
SELECT pg_temp.check((SELECT claim_payment_notification(id) IS NULL FROM payment_notification_outbox WHERE addon_purchase_id='bbbbbbbb-bbbb-4bbb-8bbb-000000000002'), 'active lease cannot be claimed twice');
UPDATE payment_notification_outbox SET lease_until=now()-interval '1 second' WHERE addon_purchase_id='bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
SELECT pg_temp.check((SELECT claim_payment_notification(id) IS NULL FROM payment_notification_outbox WHERE addon_purchase_id='bbbbbbbb-bbbb-4bbb-8bbb-000000000002'), 'expired sending lease never reclaims');
SELECT pg_temp.check((SELECT status='uncertain' AND attempts=1 FROM payment_notification_outbox WHERE addon_purchase_id='bbbbbbbb-bbbb-4bbb-8bbb-000000000002'), 'expired sending lease becomes uncertain');

SELECT * FROM credit_avatar_addon_purchase('bbbbbbbb-bbbb-4bbb-8bbb-000000000003','cs_local_3','pi_local_3','evt_local_3');
SELECT * FROM credit_avatar_addon_purchase('bbbbbbbb-bbbb-4bbb-8bbb-000000000004','cs_local_4','pi_local_4','evt_local_4');
SELECT * FROM credit_avatar_addon_purchase('bbbbbbbb-bbbb-4bbb-8bbb-000000000005','cs_local_5','pi_local_5','evt_local_5');
SELECT pg_temp.check((SELECT array_agg(addon_minutes ORDER BY addon_minutes)=ARRAY[20,50,100,200] FROM payment_notification_outbox), 'all four package sizes persisted exactly');

DO $$
DECLARE e payment_notification_outbox%rowtype;
BEGIN
 SELECT * INTO e FROM payment_notification_outbox WHERE addon_minutes=50;
 BEGIN
  INSERT INTO payment_notification_outbox(event_type,addon_purchase_id,addon_checkout_session_id,addon_minutes,addon_seconds,telegram_user_id,amount_cents,currency,paid_at)
  VALUES(e.event_type,e.addon_purchase_id,'cs_unique_attempt',50,3000,e.telegram_user_id,50,'eur',e.paid_at);
  RAISE EXCEPTION 'duplicate purchase accepted';
 EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS: purchase uniqueness enforced by SQL'; END;
 BEGIN
  INSERT INTO payment_notification_outbox(event_type,addon_purchase_id,addon_checkout_session_id,addon_minutes,addon_seconds,telegram_user_id,amount_cents,currency,paid_at)
  VALUES(e.event_type,'bbbbbbbb-bbbb-4bbb-8bbb-000000000006',e.addon_checkout_session_id,50,3000,e.telegram_user_id,50,'eur',e.paid_at);
  RAISE EXCEPTION 'duplicate checkout accepted';
 EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS: checkout uniqueness enforced by SQL'; END;
 BEGIN
  UPDATE payment_notification_outbox SET addon_minutes=NULL WHERE id=e.id;
  RAISE EXCEPTION 'null addon minutes accepted';
 EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: NULL cannot bypass event shape'; END;
 BEGIN
  UPDATE payment_notification_outbox SET addon_seconds=1200 WHERE id=e.id;
  RAISE EXCEPTION 'inconsistent seconds accepted';
 EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: inconsistent seconds rejected'; END;
END $$;

UPDATE payment_notification_outbox SET addon_minutes=20,addon_seconds=1200 WHERE addon_minutes=50;
SELECT pg_temp.check((SELECT claim_payment_notification(id) IS NULL FROM payment_notification_outbox WHERE addon_purchase_id='bbbbbbbb-bbbb-4bbb-8bbb-000000000003'), 'claim rejects tampered package evidence');
SELECT pg_temp.check((SELECT status='superseded' FROM payment_notification_outbox WHERE addon_purchase_id='bbbbbbbb-bbbb-4bbb-8bbb-000000000003'), 'tampered notice suppressed');

-- Explicit Telegram rejection can become retry, but only when due.
UPDATE payment_notification_outbox SET status='retry',next_attempt_at=now()+interval '1 hour' WHERE addon_minutes=100;
SELECT pg_temp.check((SELECT claim_payment_notification(id) IS NULL FROM payment_notification_outbox WHERE addon_minutes=100), 'retry cannot run early');
UPDATE payment_notification_outbox SET next_attempt_at=now()-interval '1 second' WHERE addon_minutes=100;
SELECT pg_temp.check((SELECT (claim_payment_notification(id)->>'status')='sending' FROM payment_notification_outbox WHERE addon_minutes=100), 'due definitive-rejection retry claims');
UPDATE payment_notification_outbox SET status='failed',lease_token=NULL,lease_until=NULL WHERE addon_minutes=100;
SELECT pg_temp.check((SELECT status='paid' FROM avatar_addon_purchases WHERE minutes=100) AND
 (SELECT purchased_seconds=6000 FROM avatar_addon_balances WHERE telegram_user_id=990000004), 'send failure leaves credit and purchase unchanged');

UPDATE avatar_addon_purchases SET status='failed' WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-000000000008';
UPDATE avatar_addon_purchases SET status='cancelled' WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-000000000009';
DO $$ DECLARE n integer; BEGIN
 FOR n IN 8..9 LOOP
  BEGIN
   PERFORM credit_avatar_addon_purchase(('bbbbbbbb-bbbb-4bbb-8bbb-' || lpad(n::text,12,'0'))::uuid,'cs_local_'||n,'','evt_failed');
   RAISE EXCEPTION 'nonpayable accepted';
  EXCEPTION WHEN raise_exception THEN
   IF SQLERRM <> 'avatar_addon_purchase_not_payable' THEN RAISE; END IF;
  END;
 END LOOP;
 RAISE NOTICE 'PASS: failed/cancelled purchases cannot credit or enqueue';
END $$;
SELECT pg_temp.check(NOT EXISTS(SELECT 1 FROM payment_notification_outbox WHERE telegram_user_id IN (990000008,990000009)), 'failed/cancelled no notices');

-- Forced enqueue failure proves credit and notice are one transaction.
CREATE FUNCTION pg_temp.reject_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test_enqueue_failure'; END $$;
CREATE TRIGGER local_reject BEFORE INSERT ON payment_notification_outbox FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_notice();
DO $$ BEGIN
 BEGIN
  PERFORM credit_avatar_addon_purchase('bbbbbbbb-bbbb-4bbb-8bbb-000000000006','cs_local_6','','evt_atomic');
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'test_enqueue_failure' THEN RAISE; END IF;
 END;
END $$;
DROP TRIGGER local_reject ON payment_notification_outbox;
SELECT pg_temp.check((SELECT status='checkout_created' FROM avatar_addon_purchases WHERE telegram_user_id=990000006)
 AND NOT EXISTS(SELECT 1 FROM avatar_addon_balances WHERE telegram_user_id=990000006), 'enqueue failure atomically rolls back uncommitted credit');

-- Existing plan notifications still enforce their original paid/access evidence.
INSERT INTO purchase_sessions VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','paid','stripe','cs_plan');
INSERT INTO payments VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','cccccccc-cccc-4ccc-8ccc-cccccccccccc','paid',990000099,'monthly',100,'eur','stripe',NULL,NULL,'cs_plan');
INSERT INTO entitlements VALUES (990000099,'dddddddd-dddd-4ddd-8ddd-dddddddddddd','monthly','active',now()+interval '1 day');
INSERT INTO payment_notification_outbox(payment_id,purchase_session_id,telegram_user_id,plan_id,amount_cents,currency,paid_at,access_expires_at)
SELECT 'dddddddd-dddd-4ddd-8ddd-dddddddddddd','cccccccc-cccc-4ccc-8ccc-cccccccccccc',990000099,'monthly',100,'eur',now(),expires_at FROM entitlements WHERE telegram_user_id=990000099;
SELECT pg_temp.check((SELECT (claim_payment_notification(id)->>'status')='sending' FROM payment_notification_outbox WHERE telegram_user_id=990000099), 'existing plan claim remains functional');
SELECT pg_temp.check(NOT has_function_privilege('anon','credit_avatar_addon_purchase(uuid,text,text,text)','EXECUTE')
 AND NOT has_function_privilege('authenticated','claim_payment_notification(uuid)','EXECUTE')
 AND has_function_privilege('service_role','claim_payment_notification(uuid)','EXECUTE'), 'service-only RPC permissions preserved');
SELECT pg_temp.check((SELECT relrowsecurity FROM pg_class WHERE oid='payment_notification_outbox'::regclass), 'outbox RLS preserved');