UPDATE users SET is_pj = (contract_type = 'pj') WHERE is_pj IS DISTINCT FROM (contract_type = 'pj');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM users GROUP BY lower(email) HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate user emails must be resolved before migration 004';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_contract_consistency;
ALTER TABLE users ADD CONSTRAINT users_contract_consistency CHECK ((contract_type = 'pj') = is_pj);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_linkedin_url_check;
ALTER TABLE users ADD CONSTRAINT users_linkedin_url_check CHECK (linkedin_url = '' OR linkedin_url ~ '^https?://');

ALTER TABLE academy DROP CONSTRAINT IF EXISTS academy_url_check;
ALTER TABLE academy ADD CONSTRAINT academy_url_check CHECK (url ~ '^https?://');

ALTER TABLE notifications_log DROP CONSTRAINT IF EXISTS notifications_log_reminder_id_fkey;
ALTER TABLE notifications_log ALTER COLUMN reminder_id DROP NOT NULL;
ALTER TABLE notifications_log ADD CONSTRAINT notifications_log_reminder_id_fkey
  FOREIGN KEY (reminder_id) REFERENCES reminders(id) ON DELETE SET NULL;
