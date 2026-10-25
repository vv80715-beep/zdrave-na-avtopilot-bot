-- Runtime invariants for production purchase-session persistence.

ALTER TABLE purchase_sessions
  ADD CONSTRAINT purchase_sessions_token_hash_format_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT purchase_sessions_telegram_user_positive_check
    CHECK (telegram_user_id > 0),
  ADD CONSTRAINT purchase_sessions_expiry_after_creation_check
    CHECK (expires_at > created_at),
  ADD CONSTRAINT purchase_sessions_updated_after_creation_check
    CHECK (updated_at >= created_at);

COMMENT ON TABLE purchase_sessions IS
  'Short-lived server-side links that bind a Telegram user to one canonical plan before checkout.';
COMMENT ON COLUMN purchase_sessions.token_hash IS
  'SHA-256 hash of the opaque browser token. The raw token is never persisted.';
