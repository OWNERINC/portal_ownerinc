ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS document JSONB;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'knowledge_base'::regclass AND conname = 'knowledge_document_check'
  ) THEN
    ALTER TABLE knowledge_base ADD CONSTRAINT knowledge_document_check CHECK (
      document IS NULL OR ((
        document = '{"kind":"ethics"}'::jsonb
        OR (
          jsonb_typeof(document) = 'object'
          AND document->>'kind' = 'pdf'
          AND jsonb_typeof(document->'key') = 'string'
          AND document->>'key' ~ '^[a-f0-9]{64}$'
          AND (document - 'kind' - 'key') = '{}'::jsonb
        )
      ) IS TRUE)
    );
  END IF;
END $$;
