-- Pages is a separate runtime. No legacy CMS data, grants or user permissions change.
CREATE TABLE IF NOT EXISTS pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_uid TEXT REFERENCES users(uid) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  draft_revision_id UUID,
  published_revision_id UUID,
  published_at TIMESTAMPTZ,
  published_by TEXT REFERENCES users(uid) ON DELETE SET NULL,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pages_publication_check CHECK ((published_revision_id IS NULL) = (published_at IS NULL)),
  CONSTRAINT pages_archive_check CHECK (archived_at IS NULL OR published_revision_id IS NULL)
);
CREATE TABLE IF NOT EXISTS page_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  title TEXT NOT NULL CHECK (length(title) <= 200),
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  audience TEXT NOT NULL DEFAULT 'job_titles' CHECK (audience = 'job_titles'),
  created_by TEXT REFERENCES users(uid) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(page_id, id)
);
CREATE TABLE IF NOT EXISTS page_revision_job_titles (
  revision_id UUID NOT NULL REFERENCES page_revisions(id) ON DELETE RESTRICT,
  job_title_id UUID NOT NULL REFERENCES job_titles(id) ON DELETE RESTRICT,
  PRIMARY KEY(revision_id, job_title_id)
);
CREATE TABLE IF NOT EXISTS page_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,
  uploaded_by TEXT REFERENCES users(uid) ON DELETE SET NULL,
  storage_key TEXT NOT NULL UNIQUE CHECK (storage_key ~ '^pages-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'),
  mime_type TEXT NOT NULL CHECK (mime_type = 'image/webp'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  width INTEGER NOT NULL CHECK (width > 0 AND width <= 2400),
  height INTEGER NOT NULL CHECK (height > 0 AND height <= 2400),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(page_id, id)
);
CREATE TABLE IF NOT EXISTS page_revision_media (
  page_id UUID NOT NULL,
  revision_id UUID NOT NULL,
  media_id UUID NOT NULL,
  PRIMARY KEY(revision_id, media_id),
  FOREIGN KEY(page_id, revision_id) REFERENCES page_revisions(page_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(page_id, media_id) REFERENCES page_media(page_id, id) ON DELETE RESTRICT
);
-- Request identity is intentionally not a FK: deletion must not free a retry key.
-- As in audit records, actor identity is retained; this table contains no content.
CREATE TABLE IF NOT EXISTS page_requests (
  actor_uid TEXT NOT NULL,
  client_mutation_id UUID NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create','draft','publish','archive','restore','media')),
  target_id UUID NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response JSONB NOT NULL CHECK (jsonb_typeof(response) = 'object' AND octet_length(response::text) <= 2048),
  status INTEGER NOT NULL CHECK (status IN (200,201)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_uid, client_mutation_id)
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'pages'::regclass AND conname = 'pages_draft_revision_fk') THEN
    ALTER TABLE pages ADD CONSTRAINT pages_draft_revision_fk FOREIGN KEY(id, draft_revision_id) REFERENCES page_revisions(page_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'pages'::regclass AND conname = 'pages_published_revision_fk') THEN
    ALTER TABLE pages ADD CONSTRAINT pages_published_revision_fk FOREIGN KEY(id, published_revision_id) REFERENCES page_revisions(page_id, id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS pages_author_idx ON pages(author_uid);
CREATE INDEX IF NOT EXISTS pages_publisher_idx ON pages(published_by);
CREATE INDEX IF NOT EXISTS pages_draft_revision_idx ON pages(draft_revision_id);
CREATE INDEX IF NOT EXISTS pages_published_revision_idx ON pages(published_revision_id);
CREATE INDEX IF NOT EXISTS pages_catalog_idx ON pages(published_at DESC, id) WHERE archived_at IS NULL AND published_revision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS page_revisions_creator_idx ON page_revisions(created_by);
CREATE INDEX IF NOT EXISTS page_revision_job_titles_job_idx ON page_revision_job_titles(job_title_id, revision_id);
CREATE INDEX IF NOT EXISTS page_media_uploader_idx ON page_media(uploaded_by);
CREATE INDEX IF NOT EXISTS page_revision_media_page_revision_idx ON page_revision_media(page_id, revision_id);
CREATE INDEX IF NOT EXISTS page_revision_media_page_media_idx ON page_revision_media(page_id, media_id);
CREATE INDEX IF NOT EXISTS page_requests_target_idx ON page_requests(target_id);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_api') THEN
    REVOKE ALL ON pages, page_revisions, page_revision_job_titles, page_media, page_revision_media, page_requests FROM portal_api;
    GRANT SELECT, INSERT, UPDATE ON pages TO portal_api;
    GRANT SELECT, INSERT ON page_revisions, page_revision_job_titles, page_media, page_revision_media, page_requests TO portal_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_cron') THEN
    REVOKE ALL ON pages, page_revisions, page_revision_job_titles, page_media, page_revision_media, page_requests FROM portal_cron;
  END IF;
END $$;
