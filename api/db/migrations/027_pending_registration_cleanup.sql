ALTER TABLE pending_registrations
  ADD COLUMN IF NOT EXISTS firebase_cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS pending_registrations_cleanup_idx
  ON pending_registrations (firebase_cleanup_pending, created_at);
