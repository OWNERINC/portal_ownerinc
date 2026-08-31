CREATE TABLE IF NOT EXISTS user_import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by TEXT REFERENCES users(uid) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed')),
  total_count INTEGER NOT NULL CHECK (total_count BETWEEN 1 AND 500),
  ready_count INTEGER NOT NULL CHECK (ready_count BETWEEN 0 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
);
CREATE TABLE IF NOT EXISTS user_import_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), job_id UUID NOT NULL REFERENCES user_import_jobs(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL CHECK (row_number >= 2), name TEXT NOT NULL, email TEXT NOT NULL, job_title TEXT NOT NULL,
  contract_type TEXT NOT NULL, pj_due_day TEXT, phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'invited', 'failed', 'invalid', 'duplicate')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3), last_error TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  invited_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_import_rows_job_row_unique UNIQUE (job_id, row_number),
  validation_errors JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(validation_errors) = 'array')
);
CREATE INDEX IF NOT EXISTS user_import_jobs_pending_idx ON user_import_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS user_import_jobs_expiry_idx ON user_import_jobs (expires_at);
CREATE INDEX IF NOT EXISTS user_import_rows_work_idx ON user_import_rows (job_id, status, attempt_count);
