-- Additive Pages identity/v3 support. Existing snapshots and grants stay intact.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE page_revisions DROP CONSTRAINT IF EXISTS page_revisions_schema_version_check;
ALTER TABLE page_revisions ADD CONSTRAINT page_revisions_schema_version_check
  CHECK (schema_version IN (1,2,3));
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'pages'::regclass AND conname = 'pages_slug_check') THEN
    ALTER TABLE pages ADD CONSTRAINT pages_slug_check CHECK (
      slug IS NULL OR (length(slug) BETWEEN 1 AND 120 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
    );
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS pages_slug_unique_idx ON pages(slug) WHERE slug IS NOT NULL;
