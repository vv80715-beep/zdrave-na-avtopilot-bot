-- Stripe Checkout, webhook idempotency, payment ledger and canonical Telegram entitlements.
-- Card data, customer email and raw webhook payloads are intentionally not stored.

ALTER TABLE purchase_sessions
  ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text,
  ADD COLUMN IF NOT EXISTS stripe_checkout_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS checkout_created_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS purchase_sessions_stripe_checkout_uidx
  ON purchase_sessions (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS purchase_sessions_checkout_status_idx
  ON purchase_sessions (stripe_checkout_session_id, status)
  WHERE stripe_checkout_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  object_id text,
  livemode boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'processed', 'failed', 'ignored')),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stripe_events_status_updated_idx
  ON stripe_events (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY,
  telegram_user_id bigint NOT NULL CHECK (telegram_user_id > 0),
  plan_id text NOT NULL CHECK (plan_id IN ('seven_day', 'monthly', 'yearly')),
  kind text NOT NULL CHECK (kind IN ('initial', 'renewal')),
  status text NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'cancelled')),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  stripe_checkout_session_id text UNIQUE,
  stripe_payment_intent_id text UNIQUE,
  stripe_invoice_id text UNIQUE,
  stripe_subscription_id text,
  stripe_customer_id text,
  first_stripe_event_id text NOT NULL,
  last_stripe_event_id text NOT NULL,
  paid_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_telegram_created_idx
  ON payments (telegram_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS payments_subscription_created_idx
  ON payments (stripe_subscription_id, created_at DESC)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS entitlements (
  telegram_user_id bigint PRIMARY KEY CHECK (telegram_user_id > 0),
  plan_id text NOT NULL CHECK (plan_id IN ('seven_day', 'monthly', 'yearly')),
  status text NOT NULL CHECK (status IN ('active', 'expired', 'cancelled')),
  billing_status text NOT NULL CHECK (
    billing_status IN ('paid', 'active', 'trialing', 'past_due', 'unpaid', 'cancelled', 'incomplete')
  ),
  stripe_customer_id text,
  stripe_subscription_id text,
  source_payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  starts_at timestamptz NOT NULL,
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (current_period_end > current_period_start),
  CHECK (expires_at >= current_period_end)
);

CREATE UNIQUE INDEX IF NOT EXISTS entitlements_stripe_subscription_uidx
  ON entitlements (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS entitlements_status_expiry_idx
  ON entitlements (status, expires_at);

COMMENT ON TABLE stripe_events IS
  'Idempotency ledger for verified Stripe webhook event IDs. Raw payloads are intentionally not persisted.';
COMMENT ON TABLE payments IS
  'Canonical payment ledger for initial Checkout payments and subscription renewal invoices.';
COMMENT ON TABLE entitlements IS
  'Backend source of truth for the Telegram user plan and server-side access expiry.';
