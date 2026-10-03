CREATE TABLE IF NOT EXISTS cms_editor_sessions (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cms_editor_sessions_expiry ON cms_editor_sessions(expires_at);
CREATE TABLE IF NOT EXISTS owner_news_authority (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  mode TEXT NOT NULL CHECK (mode IN ('legacy','frozen','payload','payload_frozen')),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK (epoch > 0),
  manifest_sha256 TEXT CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  changed_by TEXT REFERENCES users(uid) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO owner_news_authority(singleton, mode) VALUES (TRUE, 'legacy')
ON CONFLICT (singleton) DO NOTHING;
