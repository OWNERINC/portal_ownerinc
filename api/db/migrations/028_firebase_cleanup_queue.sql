CREATE TABLE IF NOT EXISTS firebase_cleanup_queue (
  firebase_uid TEXT PRIMARY KEY CHECK (btrim(firebase_uid) <> ''),
  reason TEXT NOT NULL DEFAULT 'compensation' CHECK (char_length(btrim(reason)) BETWEEN 1 AND 120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS firebase_cleanup_queue_attempt_idx
  ON firebase_cleanup_queue (last_attempt_at NULLS FIRST, created_at);
