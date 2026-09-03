ALTER TABLE job_titles
  ADD COLUMN IF NOT EXISTS page_access JSONB NOT NULL DEFAULT '{"autocard":false,"posCards":false}'::jsonb;

UPDATE job_titles
SET page_access = jsonb_set(page_access, '{autocard}', 'true'::jsonb), updated_at = NOW()
WHERE lower(name) IN ('analista de rh sênior', 'gerente de rh');

ALTER TABLE job_titles
  DROP CONSTRAINT IF EXISTS job_titles_page_access_check;

ALTER TABLE job_titles
  ADD CONSTRAINT job_titles_page_access_check CHECK (
    jsonb_typeof(page_access) = 'object'
    AND jsonb_typeof(page_access->'autocard') = 'boolean'
    AND jsonb_typeof(page_access->'posCards') = 'boolean'
  );
