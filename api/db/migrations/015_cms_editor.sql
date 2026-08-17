CREATE TABLE IF NOT EXISTS cms_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type TEXT NOT NULL CONSTRAINT cms_documents_content_type_check
    CHECK (content_type IN ('knowledge', 'academy', 'benefit', 'announcement', 'reminder')),
  source_id UUID,
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  category TEXT NOT NULL DEFAULT '' CHECK (char_length(category) <= 100),
  published_revision_id UUID,
  draft_revision_id UUID,
  scheduled_revision_id UUID,
  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_by TEXT REFERENCES users(uid) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(uid) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (content_type, source_id)
);

CREATE TABLE IF NOT EXISTS cms_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES cms_documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CONSTRAINT cms_revisions_status_check
    CHECK (status IN ('draft', 'published', 'scheduled', 'archived')),
  blocks JSONB NOT NULL CONSTRAINT cms_revisions_blocks_check
    CHECK (jsonb_typeof(blocks) = 'array'),
  created_by TEXT REFERENCES users(uid) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, version)
);

CREATE TABLE IF NOT EXISTS cms_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  original_name TEXT NOT NULL CHECK (char_length(btrim(original_name)) BETWEEN 1 AND 255),
  mime_type TEXT NOT NULL CHECK (mime_type IN (
    'image/jpeg', 'image/png', 'image/webp',
    'application/pdf',
    'video/mp4', 'video/webm', 'video/quicktime'
  )),
  byte_size BIGINT NOT NULL CHECK (byte_size BETWEEN 1 AND 52428800),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  uploaded_by TEXT REFERENCES users(uid) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cms_documents_published_revision_id_fkey') THEN
    ALTER TABLE cms_documents
      ADD CONSTRAINT cms_documents_published_revision_id_fkey
      FOREIGN KEY (published_revision_id) REFERENCES cms_revisions(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cms_documents_draft_revision_id_fkey') THEN
    ALTER TABLE cms_documents
      ADD CONSTRAINT cms_documents_draft_revision_id_fkey
      FOREIGN KEY (draft_revision_id) REFERENCES cms_revisions(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cms_documents_scheduled_revision_id_fkey') THEN
    ALTER TABLE cms_documents
      ADD CONSTRAINT cms_documents_scheduled_revision_id_fkey
      FOREIGN KEY (scheduled_revision_id) REFERENCES cms_revisions(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS cms_documents_content_type_source_id_idx
  ON cms_documents (content_type, source_id);
CREATE INDEX IF NOT EXISTS cms_revisions_status_idx
  ON cms_revisions (status, created_at DESC);
