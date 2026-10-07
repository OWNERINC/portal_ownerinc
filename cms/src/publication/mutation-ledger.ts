import { sql } from '@payloadcms/db-postgres'
import { APIError, type PayloadRequest } from 'payload'
import { isSha256, isUUID } from '../migration/identity'
import { lockCmsReferences, requireCmsTransaction } from './transaction'

/** Integration-only DDL contract. Applied by the migration owner, never runtime.
 * Sequence/events are written EXCLUSIVELY by DB triggers, including native
 * adapter.updateJobs without hooks. Do not append a second application event. */
export const NEWS_MUTATION_LEDGER_DDL = `
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

const blocks = ['rich_text', 'heading', 'paragraph', 'list_items', 'list', 'image', 'callout', 'quote', 'profile', 'divider', 'link', 'pdf', 'video']
/** Required inventory = committed editorial tables + thread3's generated run/item
 * tables. The latter are not in committed migrations yet; coverage must stay 0
 * until they exist and every listed relation has verified enabled triggers. */
export const NEWS_MUTATION_TABLES = Object.freeze([
  'news_articles', '_news_articles_v',
  ...blocks.map(name => `news_articles_blocks_${name}`),
  ...blocks.map(name => `_news_articles_v_blocks_${name}`),
  'news_home', '_news_home_v', 'news_media', 'news_schedules', 'news_audit',
  'payload_jobs', 'payload_jobs_log', 'legacy_news_revisions', 'legacy_news_revisions_rels',
  'news_migration_runs', 'news_migration_items',
])

export type NewsMutationHead = {
  sequence: string; chainSha256: string; coverageVersion: 0 | 1
  writeBarrier: 'open' | 'sealed' | 'frozen'
  barrierRunId: string | null; barrierEpoch: number | null; barrierReceiptSha256: string | null
}
const fail = (reason: string): never => { throw new APIError(reason, 503, undefined, true) }
const decimal = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= 9223372036854775807n
function nullableInteger(value: unknown): value is number | null {
  return value === null || typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function parseHead(row: Record<string, unknown> | undefined): NewsMutationHead {
  if (!row || !decimal(row.sequence) || !isSha256(row.chain_sha256)
    || (row.coverage_version !== 0 && row.coverage_version !== 1)
    || !['open', 'sealed', 'frozen'].includes(String(row.write_barrier))
    || !(row.barrier_run_id === null || typeof row.barrier_run_id === 'string' && isUUID(row.barrier_run_id))
    || !nullableInteger(row.barrier_epoch)
    || !(row.barrier_receipt_sha256 === null || isSha256(row.barrier_receipt_sha256))
    || (row.write_barrier === 'open' && (row.barrier_run_id !== null || row.barrier_epoch !== null || row.barrier_receipt_sha256 !== null))
    || (row.write_barrier !== 'open' && (row.barrier_run_id === null || row.barrier_epoch === null || row.barrier_receipt_sha256 === null))) {
    fail('news_mutation_ledger_unavailable')
  }
  return { sequence: row!.sequence as string, chainSha256: row!.chain_sha256 as string,
    coverageVersion: row!.coverage_version as 0 | 1, writeBarrier: row!.write_barrier as NewsMutationHead['writeBarrier'],
    barrierRunId: row!.barrier_run_id as string | null, barrierEpoch: row!.barrier_epoch as number | null,
    barrierReceiptSha256: row!.barrier_receipt_sha256 as string | null }
}

export async function readNewsMutationHead(req: PayloadRequest): Promise<NewsMutationHead> {
  await lockCmsReferences(req.payload, req)
  const db = await requireCmsTransaction(req.payload, req)
  const result = await db.execute(sql`SELECT sequence::text AS sequence, chain_sha256, coverage_version, write_barrier,
      barrier_run_id::text AS barrier_run_id, barrier_epoch, barrier_receipt_sha256
    FROM owner_news_mutation_head WHERE singleton=TRUE`)
  return parseHead(result.rows[0])
}

/** Comparison gate only, NOT a native drain or source-reconciliation proof.
 * baseline must come from the sealed run, never browser/CLI hash input. */
export async function assertNoNewsMutationsSince(req: PayloadRequest, baseline: NewsMutationHead): Promise<NewsMutationHead> {
  if (!baseline || !decimal(baseline.sequence) || !isSha256(baseline.chainSha256) || baseline.coverageVersion !== 1) fail('news_mutation_coverage_incomplete')
  const head = await readNewsMutationHead(req)
  if (head.coverageVersion !== 1) fail('news_mutation_coverage_incomplete')
  const db = await requireCmsTransaction(req.payload, req)
  const later = await db.execute(sql`SELECT event_id FROM owner_news_mutation_events
    WHERE sequence > ${baseline.sequence}::bigint LIMIT 1`)
  if (head.sequence !== baseline.sequence || head.chainSha256 !== baseline.chainSha256 || later.rows.length) fail('news_mutations_after_baseline')
  return head
}
