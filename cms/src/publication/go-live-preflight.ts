import { sql } from '@payloadcms/db-postgres'
import { createHash } from 'node:crypto'
import { APIError, type PayloadRequest } from 'payload'
import type { Authority } from '../contracts/news'
import { readCmsEnvironment } from '../config/environment'
import { createPortalClient } from '../auth/portal-client'
import { readNewsMutationHead } from './mutation-ledger'
import { requireCmsTransaction, withCmsTransaction } from './transaction'

const ZERO_CHAIN = '0'.repeat(64)
const fail = (reason = 'go_live_preflight_unavailable'): never => {
  throw new APIError(reason, 503, undefined, true)
}

export type GoLivePreflight = {
  ready: true
  publicationMode: 'manual'
  request: { id: string; deadline: string }
  authority: { mode: 'legacy' | 'frozen' | 'payload_frozen'; epoch: number }
  activation: null | { manifestSha256: string; sealSha256: string; releaseDigest: string
    imageDigest: string; requestId: string }
  newsEmpty: boolean
  mutation: { sequence: string; chainSha256: string; writeBarrier: 'open' | 'sealed'; barrierRunId: string | null
    barrierEpoch: number | null; barrierReceiptSha256: string | null }
  counts: { articles: number; media: number; homePublished: number; schedules: number }
  runtime: { worker: false; schedules: false; autosave: false; versions: false }
  database: { migrations: true; catalog: true; grants: true; readiness: true }
  migration: null | { runId: string; manifestSha256: string; sealSha256: string; authorityEpoch: number
    drainReceiptSha256: string }
}

type Dependencies = {
  publicationMode?: string
  getAuthority?: () => Promise<unknown>
}

export type GoLivePreflightInput = {
  mode: 'legacy' | 'frozen' | 'payload_frozen'; epoch: number; requestId: string; deadline: string
  manifestSha256?: string; sealSha256?: string; releaseDigest?: string; imageDigest?: string
}

function count(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) fail()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail()
  return parsed
}

function authority(value: unknown): Authority {
  if (!value || typeof value !== 'object') fail()
  const candidate = value as Partial<Authority>
  if (!['legacy', 'frozen', 'payload_frozen'].includes(candidate.mode || '') ||
    !Number.isSafeInteger(candidate.epoch) || candidate.epoch! < 1 || typeof candidate.activationObserved !== 'boolean'
    || !(candidate.manifestSha256 == null || typeof candidate.manifestSha256 === 'string' && /^[0-9a-f]{64}$/u.test(candidate.manifestSha256))
    || !(candidate.sealSha256 == null || typeof candidate.sealSha256 === 'string' && /^[0-9a-f]{64}$/u.test(candidate.sealSha256))
    || !(candidate.releaseDigest == null || typeof candidate.releaseDigest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(candidate.releaseDigest))
    || !(candidate.imageDigest == null || typeof candidate.imageDigest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(candidate.imageDigest))
    || !(candidate.activationRequestId == null || typeof candidate.activationRequestId === 'string'
      && /^[A-Za-z0-9._:-]{1,128}$/u.test(candidate.activationRequestId))) fail()
  return { ...candidate, manifestSha256: candidate.manifestSha256 ?? null, sealSha256: candidate.sealSha256 ?? null,
    releaseDigest: candidate.releaseDigest ?? null, imageDigest: candidate.imageDigest ?? null,
    activationRequestId: candidate.activationRequestId ?? null } as Authority
}

function preflightInput(value: GoLivePreflightInput): GoLivePreflightInput {
  const names = Object.keys(value || {})
  const allowed = ['mode', 'epoch', 'requestId', 'deadline', 'manifestSha256', 'sealSha256', 'releaseDigest', 'imageDigest']
  const bound = value?.mode !== 'legacy'
  if (!value || names.some(name => !allowed.includes(name)) || !['legacy', 'frozen', 'payload_frozen'].includes(value.mode)
    || !Number.isSafeInteger(value.epoch) || value.epoch < 1 || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.requestId || '')
    || typeof value.deadline !== 'string' || !Number.isFinite(Date.parse(value.deadline))
    || new Date(value.deadline).toISOString() !== value.deadline || Date.parse(value.deadline) <= Date.now()
    || Date.parse(value.deadline) - Date.now() > 60 * 60 * 1000
    || bound !== Object.hasOwn(value, 'manifestSha256') || bound !== Object.hasOwn(value, 'sealSha256')
    || bound !== Object.hasOwn(value, 'releaseDigest') || bound !== Object.hasOwn(value, 'imageDigest')
    || bound && (!/^[0-9a-f]{64}$/u.test(value.manifestSha256 || '') || !/^[0-9a-f]{64}$/u.test(value.sealSha256 || '')
      || !/^sha256:[0-9a-f]{64}$/u.test(value.releaseDigest || '') || !/^sha256:[0-9a-f]{64}$/u.test(value.imageDigest || ''))) fail()
  return value
}

/** Read-only activation gate. It owns no authority transition and returns only
 * bounded request binding plus aggregate safety evidence; never content, paths,
 * SQL, URLs or credentials. */
export async function queryGoLivePreflight(req: PayloadRequest, rawInput: GoLivePreflightInput,
  dependencies: Dependencies = {}): Promise<GoLivePreflight> {
  try {
    const input = preflightInput(rawInput)
    const environment = dependencies.publicationMode === undefined ? readCmsEnvironment(process.env) : null
    const publicationMode = dependencies.publicationMode ?? environment!.publicationMode
    if (publicationMode !== 'manual') fail()
    const getAuthority = dependencies.getAuthority ?? createPortalClient(environment!).getAuthority

    return await withCmsTransaction(req.payload, req, async transactionReq => {
      const currentAuthority = authority(await getAuthority())
      if (currentAuthority.mode !== input.mode || currentAuthority.epoch !== input.epoch) fail()
      const resume = input.mode === 'payload_frozen'
      if (resume ? currentAuthority.activationObserved !== false
        || currentAuthority.manifestSha256 !== input.manifestSha256 || currentAuthority.sealSha256 !== input.sealSha256
        || currentAuthority.releaseDigest !== input.releaseDigest || currentAuthority.imageDigest !== input.imageDigest
        || !currentAuthority.activationRequestId
        : currentAuthority.manifestSha256 !== null || currentAuthority.sealSha256 !== null
          || currentAuthority.releaseDigest !== null || currentAuthority.imageDigest !== null
          || currentAuthority.activationRequestId !== null || currentAuthority.activationObserved) fail()
      const mutation = await readNewsMutationHead(transactionReq)
      if (mutation.coverageVersion !== 1 || !['open', 'sealed'].includes(mutation.writeBarrier)) fail()
      const writeBarrier = mutation.writeBarrier as 'open' | 'sealed'

      const db = await requireCmsTransaction(transactionReq.payload, transactionReq)
      const result = await db.execute(sql`SELECT
        (SELECT COUNT(*)::text FROM news_articles) AS articles,
        (SELECT COUNT(*)::text FROM news_media) AS media,
        (SELECT COUNT(*)::text FROM news_home WHERE _status = 'published') AS home_published,
        (SELECT COUNT(*)::text FROM news_schedules) AS schedules,
        EXISTS(SELECT 1 FROM payload_migrations) AS migrations,
        to_regclass('public.news_articles') IS NOT NULL
          AND to_regclass('public.news_media') IS NOT NULL
          AND to_regclass('public.news_home') IS NOT NULL AS catalog,
        has_table_privilege(current_user, 'public.news_articles', 'SELECT')
          AND has_table_privilege(current_user, 'public.news_articles', 'INSERT')
          AND has_table_privilege(current_user, 'public.news_articles', 'UPDATE')
          AND has_table_privilege(current_user, 'public.news_articles', 'DELETE')
          AND has_table_privilege(current_user, 'public.news_media', 'SELECT')
          AND has_table_privilege(current_user, 'public.news_media', 'INSERT')
          AND has_table_privilege(current_user, 'public.news_media', 'UPDATE')
          AND has_table_privilege(current_user, 'public.news_media', 'DELETE') AS grants,
        NOT pg_is_in_recovery() AS readiness`)
      if (result.rows.length !== 1) fail()
      const row = result.rows[0] as Record<string, unknown>
      const counts = { articles: count(row.articles), media: count(row.media),
        homePublished: count(row.home_published), schedules: count(row.schedules) }
      if (row.migrations !== true || row.catalog !== true || row.grants !== true || row.readiness !== true) fail()

      let migration: GoLivePreflight['migration'] = null
      if (input.mode === 'legacy') {
        if (Object.values(counts).some(value => value !== 0)) fail('go_live_preflight_not_empty')
        if (mutation.sequence !== '0' || mutation.chainSha256 !== ZERO_CHAIN || mutation.writeBarrier !== 'open'
          || mutation.barrierRunId !== null || mutation.barrierEpoch !== null || mutation.barrierReceiptSha256 !== null) fail()
      } else {
        const manifestSha256 = input.manifestSha256!
        if (!resume && Object.values(counts).some(value => value !== 0)) fail('go_live_preflight_not_empty')
        const sealed = await db.execute(sql`SELECT id::text,manifest_sha256,authority_epoch::text,drain_receipt_sha256,
          reconciliation_sequence,reconciliation_chain_sha256,reconciliation_sha256,destination_fingerprint,
          sealed_sequence::text,sealed_chain_sha256,sealed_at::text,activation_epoch::text,unresolved_exceptions
          FROM news_migration_runs WHERE manifest_sha256=${manifestSha256} AND admission_state='sealed'
            AND progress_state='reconciled' AND commit_outcome='acknowledged' LIMIT 2`)
        if (sealed.rows.length !== 1) fail()
        const value = sealed.rows[0] as Record<string, unknown>
        if (typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.id)
          || value.manifest_sha256 !== manifestSha256 || typeof value.authority_epoch !== 'string'
          || !/^[1-9][0-9]*$/u.test(value.authority_epoch)
          || typeof value.activation_epoch !== 'string' || !/^[1-9][0-9]*$/u.test(value.activation_epoch)
          || typeof value.drain_receipt_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.drain_receipt_sha256)
          || typeof value.reconciliation_sequence !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value.reconciliation_sequence)
          || typeof value.reconciliation_chain_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.reconciliation_chain_sha256)
          || typeof value.reconciliation_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.reconciliation_sha256)
          || typeof value.destination_fingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(value.destination_fingerprint)
          || typeof value.sealed_sequence !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value.sealed_sequence)
          || typeof value.sealed_chain_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sealed_chain_sha256)
          || typeof value.sealed_at !== 'string' || !Number.isFinite(Date.parse(value.sealed_at))
          || !Array.isArray(value.unresolved_exceptions) || value.unresolved_exceptions.length !== 0) fail()
        const drainReceiptSha256 = String(value.drain_receipt_sha256)
        const runId = String(value.id)
        const originalEpoch = Number(value.authority_epoch), activationEpoch = Number(value.activation_epoch)
        if (activationEpoch !== originalEpoch + 1 || (!resume && originalEpoch !== currentAuthority.epoch)
          || resume && activationEpoch >= currentAuthority.epoch || mutation.writeBarrier !== 'sealed'
          || mutation.barrierRunId !== value.id || mutation.barrierEpoch !== originalEpoch
          || mutation.barrierReceiptSha256 !== drainReceiptSha256
          || !resume && (mutation.sequence !== value.sealed_sequence
            || mutation.chainSha256 !== value.sealed_chain_sha256)) fail()
        const sealMaterial = { runId, manifestSha256, authorityEpoch: value.authority_epoch,
          drainReceiptSha256, reconciliationSequence: value.reconciliation_sequence,
          reconciliationChainSha256: value.reconciliation_chain_sha256, reconciliationSha256: value.reconciliation_sha256,
          destinationFingerprint: value.destination_fingerprint, sealedSequence: value.sealed_sequence,
          sealedChainSha256: value.sealed_chain_sha256, sealedAt: value.sealed_at, activationEpoch: value.activation_epoch }
        migration = { runId, manifestSha256, authorityEpoch: Number(value.authority_epoch),
          drainReceiptSha256,
          sealSha256: createHash('sha256').update(JSON.stringify(sealMaterial)).digest('hex') }
        if (migration.sealSha256 !== input.sealSha256) fail()
      }

      const newsEmpty = Object.values(counts).every(value => value === 0)
      const activation = resume ? { manifestSha256: currentAuthority.manifestSha256!, sealSha256: currentAuthority.sealSha256!,
        releaseDigest: currentAuthority.releaseDigest!, imageDigest: currentAuthority.imageDigest!,
        requestId: currentAuthority.activationRequestId! } : null
      return { ready: true, publicationMode: 'manual', request: { id: input.requestId, deadline: input.deadline },
        authority: { mode: input.mode, epoch: input.epoch }, activation, newsEmpty,
        mutation: { sequence: mutation.sequence, chainSha256: mutation.chainSha256, writeBarrier,
          barrierRunId: mutation.barrierRunId, barrierEpoch: mutation.barrierEpoch,
          barrierReceiptSha256: mutation.barrierReceiptSha256 }, counts,
        runtime: { worker: false, schedules: false, autosave: false, versions: false },
        database: { migrations: true, catalog: true, grants: true, readiness: true }, migration }
    })
  } catch (error) {
    if (error instanceof APIError && ['go_live_preflight_unavailable', 'go_live_preflight_not_empty',
      'news_mutation_ledger_unavailable', 'cms_transaction_required'].includes(error.message)) throw error
    return fail()
  }
}
