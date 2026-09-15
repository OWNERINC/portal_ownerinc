CREATE TABLE IF NOT EXISTS pending_registrations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid      TEXT NOT NULL UNIQUE,
  email             TEXT NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  name              TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at       TIMESTAMPTZ,
  reviewed_by       TEXT REFERENCES users(uid) ON DELETE SET NULL,
  rejection_reason  TEXT CHECK (rejection_reason IS NULL OR char_length(rejection_reason) <= 500)
);

CREATE UNIQUE INDEX IF NOT EXISTS pending_registrations_pending_email_unique
  ON pending_registrations (lower(email)) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS pending_registrations_status_created_idx
  ON pending_registrations (status, created_at DESC);
