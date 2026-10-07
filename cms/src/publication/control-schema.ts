/** Integration-only migration SQL. Thread3 owns the actual Payload fields on
 * news-migration-runs; integrator applies matching SQL/types serially. */
export const NEWS_MIGRATION_CONTROL_COLUMNS_DDL = `
ALTER TABLE news_migration_runs
  ADD COLUMN reconciliation_sequence bigint CHECK (reconciliation_sequence >= 0),
  ADD COLUMN reconciliation_chain_sha256 text CHECK (reconciliation_chain_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN reconciliation_sha256 text CHECK (reconciliation_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN destination_fingerprint text CHECK (destination_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN unresolved_exceptions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(unresolved_exceptions)='array'),
  ADD COLUMN sealed_sequence bigint CHECK (sealed_sequence >= 0),
  ADD COLUMN sealed_chain_sha256 text CHECK (sealed_chain_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN sealed_at timestamptz,
  ADD COLUMN activation_epoch integer CHECK (activation_epoch > 0),
  ADD COLUMN drain_receipt_sha256 text CHECK (drain_receipt_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE news_migration_runs ADD CONSTRAINT news_migration_seal_complete CHECK (
  admission_state <> 'sealed' OR (
    progress_state='reconciled' AND commit_outcome='acknowledged' AND
    reconciliation_sequence IS NOT NULL AND reconciliation_chain_sha256 IS NOT NULL AND
    reconciliation_sha256 IS NOT NULL AND destination_fingerprint IS NOT NULL AND
    sealed_sequence IS NOT NULL AND sealed_sequence >= reconciliation_sequence AND
    sealed_chain_sha256 IS NOT NULL AND sealed_at IS NOT NULL AND
    activation_epoch=authority_epoch+1 AND drain_receipt_sha256 IS NOT NULL
  )
);
`

export type NativeDrainReceipt = Readonly<{
  version: 1
  runId: string
  authorityEpoch: number
  manifestSha256: string
  operationalBarrierId: string
  runtimeDigest: string
  receiptSha256: string
}>

/** Required server-side producer: validate the operational lock/barrier against
 * the live supervisor, no workers/import/maintenance or outstanding native job
 * finalization. Must NOT treat a caller JSON receipt/hash/lease timeout as proof.
 * No implementation is supplied until Infra's real barrier is integrated. */
export type VerifyNativeDrain = (input: {
  runId: string; manifestSha256: string; expectedEpoch: number
}) => Promise<NativeDrainReceipt>

// seal.ts implements internal composition with a REQUIRED live verifier supplied
// by the integrator. No executable CLI/endpoint or default verifier is registered.
// SQL and receipt shape alone cannot claim drain evidence.
