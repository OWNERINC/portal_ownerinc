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
    status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)
  ),
  CONSTRAINT solides_employee_links_employee_unique UNIQUE (employer_scope, employee_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS solides_employee_links_external_unique
  ON solides_employee_links (employer_scope, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS solides_employee_links_status_idx
  ON solides_employee_links (status, updated_at DESC);
