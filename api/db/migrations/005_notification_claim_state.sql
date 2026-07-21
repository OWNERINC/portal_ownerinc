ALTER TABLE notifications_log DROP CONSTRAINT IF EXISTS notifications_log_status_check;
ALTER TABLE notifications_log ADD CONSTRAINT notifications_log_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped'));
