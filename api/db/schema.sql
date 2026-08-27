-- Portal Ownerinc - schema for new PostgreSQL databases.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT        PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_titles (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT job_titles_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT job_titles_name_unique UNIQUE (name)
);

CREATE UNIQUE INDEX IF NOT EXISTS job_titles_name_lower_unique ON job_titles (lower(name));

CREATE TABLE IF NOT EXISTS users (
  uid            TEXT        PRIMARY KEY,
  email          TEXT        NOT NULL,
  name           TEXT        NOT NULL DEFAULT '',
  bio            TEXT        NOT NULL DEFAULT '',
  phone          TEXT        NOT NULL DEFAULT '',
  linkedin_url   TEXT        NOT NULL DEFAULT '',
  photo_url      TEXT        NOT NULL DEFAULT '',
  photo_crop     JSONB       NOT NULL DEFAULT '{"x":0.5,"y":0.5,"zoom":1}'::jsonb,
  role           TEXT        NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'admin')),
  contract_type  TEXT        NOT NULL DEFAULT 'clt' CHECK (contract_type IN ('clt', 'pj')),
  is_pj          BOOLEAN     NOT NULL DEFAULT FALSE,
  pj_due_day     INTEGER     CHECK (pj_due_day BETWEEN 1 AND 31),
  job_title_id   UUID        REFERENCES job_titles(id) ON DELETE RESTRICT,
  permissions    JSONB       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(permissions) = 'object'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_contract_consistency CHECK ((contract_type = 'pj') = is_pj),
  CONSTRAINT users_linkedin_url_check CHECK (linkedin_url = '' OR linkedin_url ~ '^https?://'),
  CONSTRAINT users_photo_crop_check CHECK (
    jsonb_typeof(photo_crop) = 'object'
    AND jsonb_typeof(photo_crop->'x') = 'number'
    AND jsonb_typeof(photo_crop->'y') = 'number'
    AND jsonb_typeof(photo_crop->'zoom') = 'number'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));

CREATE TABLE IF NOT EXISTS autocard_media (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key  TEXT        NOT NULL UNIQUE,
  content_type TEXT        NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size    INTEGER     NOT NULL CHECK (byte_size BETWEEN 1 AND 3145728),
  created_by   TEXT        REFERENCES users(uid) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT autocard_media_storage_key_check CHECK (storage_key ~ '^autocard-[0-9a-f-]+\.webp$')
);

CREATE TABLE IF NOT EXISTS autocard_cards (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  template     TEXT        NOT NULL CHECK (template IN ('comunicado', 'vaga', 'aniversariante', 'novo_funcionario')),
  "values"    JSONB       NOT NULL CHECK (jsonb_typeof("values") = 'object'),
  icon         TEXT,
  illustration TEXT,
  mode         TEXT        NOT NULL DEFAULT 'light' CHECK (mode IN ('light', 'dark', 'beige')),
  variant      TEXT        NOT NULL DEFAULT 'editorial' CHECK (variant IN ('editorial', 'noir', 'beige')),
  media_size   TEXT        NOT NULL DEFAULT 'medium' CHECK (media_size IN ('small', 'medium', 'large')),
  media_id     UUID        REFERENCES autocard_media(id) ON DELETE SET NULL,
  media_crop   JSONB       NOT NULL DEFAULT '{"x":0.5,"y":0.5,"zoom":1}'::jsonb,
  created_by   TEXT        REFERENCES users(uid) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT autocard_cards_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT autocard_cards_icon_check CHECK (icon IS NULL OR char_length(icon) BETWEEN 1 AND 80),
  CONSTRAINT autocard_cards_illustration_check CHECK (illustration IS NULL OR char_length(illustration) BETWEEN 1 AND 80),
  CONSTRAINT autocard_cards_media_crop_check CHECK (
    jsonb_typeof(media_crop) = 'object'
    AND jsonb_typeof(media_crop->'x') = 'number'
    AND jsonb_typeof(media_crop->'y') = 'number'
    AND jsonb_typeof(media_crop->'zoom') = 'number'
  )
);

CREATE INDEX IF NOT EXISTS autocard_cards_updated_idx ON autocard_cards (updated_at DESC);
CREATE INDEX IF NOT EXISTS autocard_cards_template_idx ON autocard_cards (template, updated_at DESC);

CREATE TABLE IF NOT EXISTS pos_card_media (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key  TEXT        NOT NULL UNIQUE,
  content_type TEXT        NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size    INTEGER     NOT NULL CHECK (byte_size BETWEEN 1 AND 3145728),
  created_by   TEXT        REFERENCES users(uid) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pos_card_media_storage_key_check CHECK (storage_key ~ '^pos-card-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$')
);

CREATE TABLE IF NOT EXISTS pos_cards (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  template   TEXT        NOT NULL CHECK (template IN ('convite_owntime')),
  "values"  JSONB       NOT NULL CHECK (jsonb_typeof("values") = 'object'),
  media_id   UUID        REFERENCES pos_card_media(id) ON DELETE SET NULL,
  created_by TEXT        REFERENCES users(uid) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pos_cards_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS pos_cards_updated_idx ON pos_cards (updated_at DESC);
CREATE INDEX IF NOT EXISTS pos_cards_template_idx ON pos_cards (template, updated_at DESC);

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
  last_error          TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  alert_signature     TEXT CHECK (alert_signature IS NULL OR char_length(alert_signature) <= 200),
  alert_sent_at       TIMESTAMPTZ
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
  ('008_solides_link_hardening'),
  ('009_job_titles'),
  ('010_autocard'),
  ('011_cron_alert_state'),
  ('012_autocard_media_crop'),
  ('017_pos_cards'),
  ('018_pos_card_storage_key'),
  ('020_profile_photo_crop')
ON CONFLICT (version) DO NOTHING;
