ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS scheduled_date DATE;
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE notifications_log ALTER COLUMN sent_at DROP NOT NULL;
ALTER TABLE notifications_log ALTER COLUMN sent_at DROP DEFAULT;

UPDATE notifications_log
SET scheduled_date = COALESCE(scheduled_date, sent_at::date, claimed_at::date),
    finished_at = COALESCE(finished_at, sent_at, claimed_at),
    channel = CASE WHEN channel IN ('email', 'whatsapp') THEN channel ELSE 'email' END,
    status = CASE WHEN status IN ('pending', 'sent', 'failed', 'skipped') THEN status ELSE 'failed' END
WHERE scheduled_date IS NULL
   OR finished_at IS NULL
   OR channel NOT IN ('email', 'whatsapp')
   OR status NOT IN ('pending', 'sent', 'failed', 'skipped');

ALTER TABLE notifications_log ALTER COLUMN reminder_id SET NOT NULL;
ALTER TABLE notifications_log ALTER COLUMN user_uid SET NOT NULL;
ALTER TABLE notifications_log ALTER COLUMN scheduled_date SET NOT NULL;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM notifications_log
    GROUP BY reminder_id, user_uid, scheduled_date, channel
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate notification occurrences must be reviewed before migration 002';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('viewer', 'admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_contract_type_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_contract_type_check CHECK (contract_type IN ('clt', 'pj'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_pj_due_day_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_pj_due_day_check CHECK (pj_due_day BETWEEN 1 AND 31);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_permissions_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_permissions_check CHECK (jsonb_typeof(permissions) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reminders_channel_check') THEN
    ALTER TABLE reminders ADD CONSTRAINT reminders_channel_check CHECK (channel IN ('email', 'whatsapp', 'both'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reminders_target_users_check') THEN
    ALTER TABLE reminders ADD CONSTRAINT reminders_target_users_check CHECK (
      target_users IN ('"all"'::jsonb, '"pj"'::jsonb, '"clt"'::jsonb)
      OR (jsonb_typeof(target_users) = 'array' AND NOT jsonb_path_exists(target_users, '$[*] ? (@.type() != "string")'))
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_log_channel_check') THEN
    ALTER TABLE notifications_log ADD CONSTRAINT notifications_log_channel_check CHECK (channel IN ('email', 'whatsapp'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_log_status_check') THEN
    ALTER TABLE notifications_log ADD CONSTRAINT notifications_log_status_check CHECK (status IN ('pending', 'sent', 'failed', 'skipped'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_log_attempt_count_check') THEN
    ALTER TABLE notifications_log ADD CONSTRAINT notifications_log_attempt_count_check CHECK (attempt_count BETWEEN 1 AND 3);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_log_occurrence_key
  ON notifications_log (reminder_id, user_uid, scheduled_date, channel);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_log_occurrence_key') THEN
    ALTER TABLE notifications_log ADD CONSTRAINT notifications_log_occurrence_key
      UNIQUE USING INDEX notifications_log_occurrence_key;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_uid TEXT REFERENCES users(uid) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  request_id TEXT,
  details JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cron_status (
  name TEXT PRIMARY KEY,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_started_at TIMESTAMPTZ,
  last_finished_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_scheduled_date DATE,
  duration_ms INTEGER CHECK (duration_ms >= 0),
  attempted_count INTEGER NOT NULL DEFAULT 0 CHECK (attempted_count >= 0),
  sent_count INTEGER NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  last_error TEXT
);
