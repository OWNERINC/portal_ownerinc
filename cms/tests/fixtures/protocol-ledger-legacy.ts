/** Frozen pre-qualification installation SQL, not production DDL. This fixture
 * independently checks catalog compatibility; do not derive it from the builder. */
export const legacyLedgerHeadDDL = `
CREATE TABLE owner_news_mutation_head (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  chain_sha256 text NOT NULL CHECK (chain_sha256 ~ '^[0-9a-f]{64}$'),
  coverage_version integer NOT NULL DEFAULT 0 CHECK (coverage_version IN (0,1)),
  write_barrier text NOT NULL DEFAULT 'open' CHECK (write_barrier IN ('open','sealed','frozen')),
  barrier_run_id uuid REFERENCES news_migration_runs(id) ON DELETE RESTRICT,
  barrier_epoch integer CHECK (barrier_epoch > 0),
  barrier_receipt_sha256 text CHECK (barrier_receipt_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (write_barrier='open' OR (barrier_run_id IS NOT NULL AND barrier_epoch IS NOT NULL AND barrier_receipt_sha256 IS NOT NULL))
);
`
export const legacyLedgerDDL = `${legacyLedgerHeadDDL}
INSERT INTO owner_news_mutation_head(singleton,sequence,chain_sha256,coverage_version)
VALUES (true,0,repeat('0',64),0);
CREATE TABLE owner_news_mutation_events (
  sequence bigint PRIMARY KEY CHECK (sequence > 0),
  event_id uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  table_name text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE','TRUNCATE')),
  row_key text NOT NULL,
  transaction_id text NOT NULL,
  before_sha256 text CHECK (before_sha256 ~ '^[0-9a-f]{64}$'),
  after_sha256 text CHECK (after_sha256 ~ '^[0-9a-f]{64}$'),
  previous_sha256 text NOT NULL CHECK (previous_sha256 ~ '^[0-9a-f]{64}$'),
  event_sha256 text NOT NULL CHECK (event_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
`
