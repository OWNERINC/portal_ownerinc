ALTER TABLE user_import_rows DROP CONSTRAINT IF EXISTS user_import_rows_job_email_unique;
ALTER TABLE user_import_rows DROP CONSTRAINT IF EXISTS user_import_rows_contract_type_check;
ALTER TABLE user_import_rows DROP CONSTRAINT IF EXISTS user_import_rows_pj_consistency;
ALTER TABLE user_import_rows ALTER COLUMN pj_due_day TYPE TEXT USING pj_due_day::TEXT;
ALTER TABLE user_import_rows ADD COLUMN IF NOT EXISTS validation_errors JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(validation_errors) = 'array');
ALTER TABLE user_import_rows DROP CONSTRAINT IF EXISTS user_import_rows_status_check;
ALTER TABLE user_import_rows ADD CONSTRAINT user_import_rows_status_check CHECK (status IN ('pending', 'processing', 'invited', 'failed', 'invalid', 'duplicate'));
