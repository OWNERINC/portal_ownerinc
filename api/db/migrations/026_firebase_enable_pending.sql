ALTER TABLE users
  ADD COLUMN IF NOT EXISTS firebase_enable_pending BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS users_firebase_enable_pending_idx
  ON users (created_at)
  WHERE firebase_enable_pending = TRUE;
