-- No backfill: every existing account, including super admins, starts pending.
CREATE TABLE IF NOT EXISTS ethics_acceptances (
  user_uid       TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  term_version   TEXT NOT NULL CHECK (char_length(btrim(term_version)) BETWEEN 1 AND 120),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  is_mock        BOOLEAN NOT NULL,
  accepted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_uid, term_version, content_sha256)
);

REVOKE ALL ON ethics_acceptances FROM PUBLIC, portal_api, portal_cron;
GRANT SELECT, INSERT ON ethics_acceptances TO portal_api;
