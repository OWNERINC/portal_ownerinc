ALTER TABLE cms_revisions ADD COLUMN IF NOT EXISTS editorial JSONB;
ALTER TABLE cms_revisions ADD CONSTRAINT cms_revisions_editorial_object_check
  CHECK (editorial IS NULL OR jsonb_typeof(editorial) = 'object');

CREATE TABLE owner_news_home (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  draft JSONB CHECK (draft IS NULL OR jsonb_typeof(draft) = 'object'),
  published JSONB CHECK (published IS NULL OR jsonb_typeof(published) = 'object'),
  updated_by TEXT REFERENCES users(uid) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ
);
INSERT INTO owner_news_home(singleton) VALUES (TRUE);
