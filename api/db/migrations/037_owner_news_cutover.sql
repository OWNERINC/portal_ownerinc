ALTER TABLE owner_news_authority
  ADD COLUMN IF NOT EXISTS seal_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS release_digest TEXT,
  ADD COLUMN IF NOT EXISTS image_digest TEXT,
  ADD COLUMN IF NOT EXISTS activation_request_id TEXT,
  ADD COLUMN IF NOT EXISTS activation_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS transition_request_id TEXT,
  ADD COLUMN IF NOT EXISTS transition_actor_uid TEXT,
  ADD COLUMN IF NOT EXISTS transition_operator_uid TEXT,
  ADD COLUMN IF NOT EXISTS transition_action TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='owner_news_authority'::regclass
      AND conname='owner_news_authority_seal_sha256_check') THEN
    ALTER TABLE owner_news_authority ADD CONSTRAINT owner_news_authority_seal_sha256_check
      CHECK (seal_sha256 IS NULL OR seal_sha256 ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='owner_news_authority'::regclass
      AND conname='owner_news_authority_release_digest_check') THEN
    ALTER TABLE owner_news_authority ADD CONSTRAINT owner_news_authority_release_digest_check
      CHECK (release_digest IS NULL OR release_digest ~ '^sha256:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='owner_news_authority'::regclass
      AND conname='owner_news_authority_image_digest_check') THEN
    ALTER TABLE owner_news_authority ADD CONSTRAINT owner_news_authority_image_digest_check
      CHECK (image_digest IS NULL OR image_digest ~ '^sha256:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='owner_news_authority'::regclass
      AND conname='owner_news_authority_activation_request_check') THEN
    ALTER TABLE owner_news_authority ADD CONSTRAINT owner_news_authority_activation_request_check
      CHECK (activation_request_id IS NULL OR activation_request_id ~ '^[A-Za-z0-9._:-]{1,128}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='owner_news_authority'::regclass
      AND conname='owner_news_authority_transition_identity_check') THEN
    ALTER TABLE owner_news_authority ADD CONSTRAINT owner_news_authority_transition_identity_check CHECK (
      (transition_request_id IS NULL AND transition_actor_uid IS NULL AND transition_operator_uid IS NULL
        AND transition_action IS NULL)
      OR (transition_request_id ~ '^[A-Za-z0-9._:-]{1,128}$'
        AND transition_actor_uid IS NOT NULL AND transition_operator_uid IS NOT NULL
        AND transition_actor_uid <> transition_operator_uid
        AND transition_action IN ('freeze','activate','observe','freeze-payload','resume-payload'))
    );
  END IF;
  -- Existing installations may already be in payload under the pre-Gate-E contract.
  -- NOT VALID preserves that row while enforcing the complete contract on every
  -- subsequent INSERT/UPDATE. The verifier exposes this staged validation state.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='owner_news_authority'::regclass
      AND conname='owner_news_authority_activation_state_check') THEN
    ALTER TABLE owner_news_authority ADD CONSTRAINT owner_news_authority_activation_state_check CHECK (
      (mode = 'payload' AND manifest_sha256 IS NOT NULL AND seal_sha256 IS NOT NULL
        AND release_digest IS NOT NULL AND image_digest IS NOT NULL AND activation_request_id IS NOT NULL)
      OR (mode <> 'payload' AND activation_observed_at IS NULL)
    ) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS owner_news_authority_transitions (
  request_id TEXT NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  action TEXT NOT NULL CHECK (action IN ('freeze','activate','observe','freeze-payload','resume-payload')),
  actor_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  operator_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  from_mode TEXT NOT NULL CHECK (from_mode IN ('legacy','frozen','payload','payload_frozen')),
  to_mode TEXT NOT NULL CHECK (to_mode IN ('legacy','frozen','payload','payload_frozen')),
  previous_epoch INTEGER NOT NULL CHECK (previous_epoch > 0),
  resulting_epoch INTEGER NOT NULL CHECK (resulting_epoch > 0),
  evidence_sha256 TEXT NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (request_id, action),
  UNIQUE (resulting_epoch, action),
  CHECK (actor_uid <> operator_uid),
  CHECK ((action='observe' AND from_mode=to_mode AND previous_epoch=resulting_epoch)
    OR (action<>'observe' AND resulting_epoch=previous_epoch+1))
);
