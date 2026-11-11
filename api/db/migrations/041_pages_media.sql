-- Expand only Pages. Historical revisions and grants are deliberately untouched.
ALTER TABLE page_revisions DROP CONSTRAINT IF EXISTS page_revisions_schema_version_check;
ALTER TABLE page_revisions ADD CONSTRAINT page_revisions_schema_version_check CHECK (schema_version IN (1,2));
ALTER TABLE page_media ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'image';
ALTER TABLE page_media ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE page_media ADD COLUMN IF NOT EXISTS frame_count INTEGER;
ALTER TABLE page_media ALTER COLUMN width DROP NOT NULL;
ALTER TABLE page_media ALTER COLUMN height DROP NOT NULL;
ALTER TABLE page_media DROP CONSTRAINT IF EXISTS page_media_storage_key_check;
ALTER TABLE page_media DROP CONSTRAINT IF EXISTS page_media_mime_type_check;
ALTER TABLE page_media DROP CONSTRAINT IF EXISTS page_media_byte_size_check;
ALTER TABLE page_media DROP CONSTRAINT IF EXISTS page_media_width_check;
ALTER TABLE page_media DROP CONSTRAINT IF EXISTS page_media_height_check;
ALTER TABLE page_media DROP CONSTRAINT IF EXISTS page_media_typed_check;
ALTER TABLE page_media ADD CONSTRAINT page_media_typed_check CHECK ((
  (kind = 'image' AND mime_type = 'image/webp' AND storage_key ~ '^pages-[0-9a-f-]{36}\.webp$'
    AND byte_size BETWEEN 1 AND 5242880 AND width BETWEEN 1 AND 2400 AND height BETWEEN 1 AND 2400
    AND duration_ms IS NULL AND frame_count IS NULL)
  OR (kind = 'gif' AND mime_type = 'image/gif' AND storage_key ~ '^pages-[0-9a-f-]{36}\.gif$'
    AND byte_size BETWEEN 1 AND 8388608 AND width > 0 AND height > 0 AND width::bigint * height * frame_count <= 20000000
    AND duration_ms BETWEEN 1 AND 30000 AND frame_count BETWEEN 1 AND 100)
  OR (kind = 'audio' AND mime_type = 'audio/mpeg' AND storage_key ~ '^pages-[0-9a-f-]{36}\.mp3$'
    AND byte_size BETWEEN 1 AND 10485760 AND width IS NULL AND height IS NULL AND frame_count IS NULL
    AND duration_ms BETWEEN 1 AND 600000)
  OR (kind = 'video' AND mime_type = 'video/mp4' AND storage_key ~ '^pages-[0-9a-f-]{36}\.mp4$'
    AND byte_size BETWEEN 1 AND 26214400 AND width BETWEEN 1 AND 1920 AND height BETWEEN 1 AND 1080
    AND duration_ms BETWEEN 1 AND 120000 AND frame_count > 0)
) IS TRUE);
