-- Align Avatar included allowances with the public plans:
-- monthly: 20 minutes (1200s), yearly: 10 minutes (600s).
-- Preserve add-on balances and the existing atomic reservation/settlement flow.

DO $$
DECLARE
  fn text;
  ddl text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['avatar_allowance','avatar_reserve','avatar_transition','record_avatar_usage']
  LOOP
    SELECT pg_get_functiondef(p.oid)
      INTO ddl
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = fn
      AND p.prokind = 'f'
    ORDER BY p.oid
    LIMIT 1;

    IF ddl IS NULL THEN
      RAISE EXCEPTION 'required_function_missing: %', fn;
    END IF;

    ddl := replace(
      ddl,
      'CASE WHEN e.plan_id=''monthly'' THEN 1800 ELSE 1200 END',
      'CASE WHEN e.plan_id=''monthly'' THEN 1200 ELSE 600 END'
    );
    ddl := replace(
      ddl,
      'CASE WHEN r.plan_id=''monthly'' THEN 1800 ELSE 1200 END',
      'CASE WHEN r.plan_id=''monthly'' THEN 1200 ELSE 600 END'
    );

    EXECUTE ddl;
  END LOOP;
END $$;
