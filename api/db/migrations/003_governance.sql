ALTER TABLE ombudsman ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE ombudsman ADD COLUMN IF NOT EXISTS assigned_to TEXT REFERENCES users(uid) ON DELETE SET NULL;
ALTER TABLE ombudsman ADD COLUMN IF NOT EXISTS internal_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE ombudsman ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE ombudsman ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM knowledge_base WHERE char_length(title) > 200 OR char_length(category) > 100 OR char_length(content) > 50000)
    OR EXISTS (SELECT 1 FROM reminders WHERE char_length(title) > 200 OR char_length(description) > 5000)
    OR EXISTS (SELECT 1 FROM academy WHERE char_length(title) > 200 OR char_length(category) > 100 OR char_length(description) > 5000 OR char_length(url) > 2048 OR "order" NOT BETWEEN -100000 AND 100000)
    OR EXISTS (SELECT 1 FROM benefits WHERE char_length(company) > 200 OR char_length(category) > 100 OR char_length(description) > 5000 OR char_length(instructions) > 10000 OR "order" NOT BETWEEN -100000 AND 100000)
    OR EXISTS (SELECT 1 FROM ombudsman WHERE char_length(category) > 100 OR char_length(message) > 10000 OR char_length(internal_notes) > 10000)
    OR EXISTS (SELECT 1 FROM notifications_log WHERE char_length(last_error) > 1000)
    OR EXISTS (SELECT 1 FROM cron_status WHERE char_length(last_error) > 1000)
  THEN
    RAISE EXCEPTION 'Oversized legacy data must be reviewed before migration 003';
  END IF;
END $$;

ALTER TABLE knowledge_base DROP CONSTRAINT IF EXISTS knowledge_base_content_lengths;
ALTER TABLE knowledge_base ADD CONSTRAINT knowledge_base_content_lengths CHECK (
  char_length(title) <= 200 AND char_length(category) <= 100 AND char_length(content) <= 50000
);
ALTER TABLE reminders DROP CONSTRAINT IF EXISTS reminders_content_lengths;
ALTER TABLE reminders ADD CONSTRAINT reminders_content_lengths CHECK (
  char_length(title) <= 200 AND char_length(description) <= 5000
);
ALTER TABLE academy DROP CONSTRAINT IF EXISTS academy_content_lengths;
ALTER TABLE academy ADD CONSTRAINT academy_content_lengths CHECK (
  char_length(title) <= 200 AND char_length(category) <= 100
  AND char_length(description) <= 5000 AND char_length(url) <= 2048
  AND "order" BETWEEN -100000 AND 100000
);
ALTER TABLE benefits DROP CONSTRAINT IF EXISTS benefits_content_lengths;
ALTER TABLE benefits ADD CONSTRAINT benefits_content_lengths CHECK (
  char_length(company) <= 200 AND char_length(category) <= 100
  AND char_length(description) <= 5000 AND char_length(instructions) <= 10000
  AND "order" BETWEEN -100000 AND 100000
);
ALTER TABLE ombudsman DROP CONSTRAINT IF EXISTS ombudsman_status_check;
ALTER TABLE ombudsman ADD CONSTRAINT ombudsman_status_check CHECK (status IN ('new', 'in_review', 'resolved'));
ALTER TABLE ombudsman DROP CONSTRAINT IF EXISTS ombudsman_content_lengths;
ALTER TABLE ombudsman ADD CONSTRAINT ombudsman_content_lengths CHECK (
  char_length(category) <= 100 AND char_length(message) <= 10000
  AND char_length(internal_notes) <= 10000 AND (assigned_to IS NULL OR char_length(assigned_to) <= 128)
);
ALTER TABLE ombudsman DROP CONSTRAINT IF EXISTS ombudsman_resolution_check;
ALTER TABLE ombudsman ADD CONSTRAINT ombudsman_resolution_check CHECK (
  (status = 'resolved' AND resolved_at IS NOT NULL) OR (status <> 'resolved' AND resolved_at IS NULL)
);
ALTER TABLE notifications_log DROP CONSTRAINT IF EXISTS notifications_log_error_length;
ALTER TABLE notifications_log ADD CONSTRAINT notifications_log_error_length CHECK (
  last_error IS NULL OR char_length(last_error) <= 1000
);
ALTER TABLE cron_status DROP CONSTRAINT IF EXISTS cron_status_error_length;
ALTER TABLE cron_status ADD CONSTRAINT cron_status_error_length CHECK (
  last_error IS NULL OR char_length(last_error) <= 1000
);

CREATE INDEX IF NOT EXISTS notifications_log_history_idx
  ON notifications_log (scheduled_date DESC, claimed_at DESC);
CREATE INDEX IF NOT EXISTS ombudsman_workflow_idx
  ON ombudsman (status, assigned_to, created_at DESC);
