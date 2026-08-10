ALTER TABLE cron_status
  ADD COLUMN IF NOT EXISTS alert_signature TEXT,
  ADD COLUMN IF NOT EXISTS alert_sent_at TIMESTAMPTZ;

ALTER TABLE cron_status
  DROP CONSTRAINT IF EXISTS cron_status_alert_signature_check;

ALTER TABLE cron_status
  ADD CONSTRAINT cron_status_alert_signature_check
  CHECK (alert_signature IS NULL OR char_length(alert_signature) <= 200);
