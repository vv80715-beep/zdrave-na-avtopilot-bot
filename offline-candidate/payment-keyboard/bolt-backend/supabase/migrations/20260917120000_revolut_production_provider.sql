-- Separate production checkout records from TEST without reclassifying history.
-- No payment/entitlement/auth data is changed. TEST confirmation RPC stays TEST-only.
BEGIN;
ALTER TABLE public.purchase_sessions
  DROP CONSTRAINT purchase_sessions_checkout_provider_check;
ALTER TABLE public.purchase_sessions
  ADD CONSTRAINT purchase_sessions_checkout_provider_check
  CHECK (checkout_provider IS NULL OR checkout_provider IN ('stripe', 'revolut_pro_test', 'revolut_pro'));
COMMIT;