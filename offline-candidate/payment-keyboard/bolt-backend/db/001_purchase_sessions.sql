-- PostgreSQL-ready source-of-truth schema for the purchase-session stage.
-- The raw opaque token is NEVER stored. Only its SHA-256 hash is persisted.

CREATE TABLE IF NOT EXISTS purchase_sessions (
  id uuid PRIMARY KEY,
  token_hash char(64) NOT NULL UNIQUE,
  telegram_user_id bigint NOT NULL,
  plan_id text NOT NULL CHECK (plan_id IN ('seven_day', 'monthly', 'yearly')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'checkout_created', 'paid', 'expired', 'cancelled')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS purchase_sessions_telegram_user_idx
  ON purchase_sessions (telegram_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS purchase_sessions_status_expiry_idx
  ON purchase_sessions (status, expires_at);
