-- Portal Ownerinc - schema for new PostgreSQL databases.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT        PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  uid            TEXT        PRIMARY KEY,
  email          TEXT        NOT NULL,
  name           TEXT        NOT NULL DEFAULT '',
  bio            TEXT        NOT NULL DEFAULT '',
  phone          TEXT        NOT NULL DEFAULT '',
  linkedin_url   TEXT        NOT NULL DEFAULT '',
  photo_url      TEXT        NOT NULL DEFAULT '',
  role           TEXT        NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'admin')),
  contract_type  TEXT        NOT NULL DEFAULT 'clt' CHECK (contract_type IN ('clt', 'pj')),
  is_pj          BOOLEAN     NOT NULL DEFAULT FALSE,
  pj_due_day     INTEGER     CHECK (pj_due_day BETWEEN 1 AND 31),
  permissions    JSONB       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(permissions) = 'object'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_contract_consistency CHECK ((contract_type = 'pj') = is_pj),
  CONSTRAINT users_linkedin_url_check CHECK (linkedin_url = '' OR linkedin_url ~ '^https?://')
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));

CREATE TABLE IF NOT EXISTS knowledge_base (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT        NOT NULL,
  category    TEXT        NOT NULL DEFAULT '',
  content     TEXT        NOT NULL DEFAULT '',
  created_by  TEXT        REFERENCES users(uid) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT knowledge_base_content_lengths CHECK (
    char_length(title) <= 200 AND char_length(category) <= 100 AND char_length(content) <= 50000
  )
);

CREATE TABLE IF NOT EXISTS reminders (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT        NOT NULL,
  description   TEXT        NOT NULL DEFAULT '',
  trigger_day   INTEGER     NOT NULL CHECK (trigger_day BETWEEN 1 AND 31),
  target_users  JSONB       NOT NULL DEFAULT '"all"' CHECK (
    target_users IN ('"all"'::jsonb, '"pj"'::jsonb, '"clt"'::jsonb)
    OR (jsonb_typeof(target_users) = 'array' AND NOT jsonb_path_exists(target_users, '$[*] ? (@.type() != "string")'))
  ),
  channel       TEXT        NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'whatsapp', 'both')),
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by    TEXT        REFERENCES users(uid) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reminders_content_lengths CHECK (
    char_length(title) <= 200 AND char_length(description) <= 5000
  )
);

CREATE TABLE IF NOT EXISTS academy (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT        NOT NULL,
  category     TEXT        NOT NULL DEFAULT '',
  description  TEXT        NOT NULL DEFAULT '',
  url          TEXT        NOT NULL CHECK (url ~ '^https?://'),
  "order"      INTEGER     NOT NULL DEFAULT 0,
  active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT academy_content_lengths CHECK (
    char_length(title) <= 200 AND char_length(category) <= 100
    AND char_length(description) <= 5000 AND char_length(url) <= 2048
    AND "order" BETWEEN -100000 AND 100000
  )
);

CREATE TABLE IF NOT EXISTS benefits (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company       TEXT        NOT NULL,
  category      TEXT        NOT NULL DEFAULT '',
  description   TEXT        NOT NULL DEFAULT '',
  instructions  TEXT        NOT NULL DEFAULT '',
  "order"       INTEGER     NOT NULL DEFAULT 0,
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT benefits_content_lengths CHECK (
    char_length(company) <= 200 AND char_length(category) <= 100
    AND char_length(description) <= 5000 AND char_length(instructions) <= 10000
    AND "order" BETWEEN -100000 AND 100000
  )
);

CREATE TABLE IF NOT EXISTS ombudsman (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  category        TEXT        NOT NULL DEFAULT '',
  message         TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_review', 'resolved')),
  assigned_to     TEXT        REFERENCES users(uid) ON DELETE SET NULL,
  internal_notes  TEXT        NOT NULL DEFAULT '',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ombudsman_content_lengths CHECK (
    char_length(category) <= 100 AND char_length(message) <= 10000
    AND char_length(internal_notes) <= 10000 AND (assigned_to IS NULL OR char_length(assigned_to) <= 128)
  ),
  CONSTRAINT ombudsman_resolution_check CHECK (
    (status = 'resolved' AND resolved_at IS NOT NULL) OR (status <> 'resolved' AND resolved_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS notifications_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id     UUID        REFERENCES reminders(id) ON DELETE SET NULL,
  user_uid        TEXT        REFERENCES users(uid) ON DELETE SET NULL,
  scheduled_date  DATE        NOT NULL,
  channel         TEXT        NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  status          TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempt_count   INTEGER     NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 3),
  claimed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  last_error      TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  CONSTRAINT notifications_log_occurrence_key UNIQUE (reminder_id, user_uid, scheduled_date, channel)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_uid   TEXT        REFERENCES users(uid) ON DELETE SET NULL,
  action      TEXT        NOT NULL,
  target_type TEXT        NOT NULL,
  target_id   TEXT,
  request_id  TEXT,
  details     JSONB       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cron_status (
  name                TEXT        PRIMARY KEY,
  heartbeat_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_started_at     TIMESTAMPTZ,
  last_finished_at    TIMESTAMPTZ,
  last_success_at     TIMESTAMPTZ,
  last_scheduled_date DATE,
  duration_ms         INTEGER     CHECK (duration_ms >= 0),
  attempted_count     INTEGER     NOT NULL DEFAULT 0 CHECK (attempted_count >= 0),
  sent_count          INTEGER     NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  failed_count        INTEGER     NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  skipped_count       INTEGER     NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  last_error          TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 1000)
);

CREATE TABLE IF NOT EXISTS solides_employee_links (
  user_uid             TEXT        PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  employee_id          BIGINT      NOT NULL CHECK (employee_id > 0),
  external_id          TEXT,
  employer_scope       TEXT        NOT NULL DEFAULT 'default',
  status               TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'disabled', 'conflict')),
  matched_by           TEXT        NOT NULL DEFAULT 'manual' CHECK (matched_by IN ('manual', 'external_id')),
  verified_by          TEXT        REFERENCES users(uid) ON DELETE SET NULL,
  verified_at          TIMESTAMPTZ,
  last_seen_at         TIMESTAMPTZ,
  upstream_updated_at  TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT solides_employee_links_lengths CHECK (
    (external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 200)
    AND char_length(employer_scope) BETWEEN 1 AND 100
  ),
  CONSTRAINT solides_employee_links_verification CHECK (
    status <> 'verified' OR verified_at IS NOT NULL
  ),
  CONSTRAINT solides_employee_links_scope_check CHECK (employer_scope = 'default'),
  CONSTRAINT solides_employee_links_employee_unique UNIQUE (employee_id)
);

CREATE INDEX IF NOT EXISTS notifications_log_history_idx
  ON notifications_log (scheduled_date DESC, claimed_at DESC);
CREATE INDEX IF NOT EXISTS ombudsman_workflow_idx
  ON ombudsman (status, assigned_to, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS solides_employee_links_external_unique
  ON solides_employee_links (employer_scope, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS solides_employee_links_status_idx
  ON solides_employee_links (status, updated_at DESC);

INSERT INTO schema_migrations (version) VALUES
  ('001_initial_schema'),
  ('002_reliable_notifications'),
  ('003_governance'),
  ('004_operational_hardening'),
  ('005_notification_claim_state'),
  ('006_user_erasure'),
  ('007_solides_employee_links'),
  ('008_solides_link_hardening')
ON CONFLICT (version) DO NOTHING;
