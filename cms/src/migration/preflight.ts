import path from 'node:path'
import { loadBundle } from '../../../scripts/owner-news-payload/bundle.mjs'
import { assertImportStorageIsolation, readImportEnvironment } from './target'
import { preflightImportDatabases, type ImportClientFactory } from './database-preflight'
import { planLoadedNewsImport, summarizeImportPlan } from './plan'
import { assertPrivatePath } from '../../../scripts/owner-news-payload/files.mjs'
import type { ConvertedImportRevision, ImportBundleManifest } from './bundle'

type LoadedImportBundle = {
  manifest: ImportBundleManifest
  manifestSha256: string
  revisionById: ReadonlyMap<string, { converted: ConvertedImportRevision }>
  assetPaths: ReadonlyMap<string, string>
}

function isLoadedBundle(value: unknown): value is LoadedImportBundle {
  if (!value || typeof value !== 'object') return false
  const bundle = value as Record<string, unknown>
  return !!bundle.manifest && typeof bundle.manifest === 'object' &&
    typeof bundle.manifestSha256 === 'string' && /^[a-f0-9]{64}$/u.test(bundle.manifestSha256) &&
    bundle.revisionById instanceof Map && bundle.assetPaths instanceof Map
}

function requireLoadedBundle(value: unknown): LoadedImportBundle {
  if (!isLoadedBundle(value)) throw new Error('import_bundle_load_failed')
  return value
}

/** Argument parsing is side-effect free; execution is a distinct read-only
 * preflight and never implies that the mutation/apply phase is available. */
export function parseImportArguments(args: readonly string[]): { bundlePath: string; apply: boolean } {
  let bundlePath: string | undefined
  let mode: '--apply' | '--dry-run' | undefined
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--bundle' && bundlePath === undefined) {
      bundlePath = args[++index]
      if (!bundlePath || !path.isAbsolute(bundlePath) || /[\x00-\x1f\x7f]/u.test(bundlePath)) throw new Error('invalid_import_arguments')
    } else if ((flag === '--apply' || flag === '--dry-run') && mode === undefined) mode = flag
    else throw new Error('invalid_import_arguments')
  }
  if (!bundlePath) throw new Error('invalid_import_arguments')
  return { bundlePath, apply: mode === '--apply' }
}

export type ImportPreflightDependencies = {
  env?: Record<string, string | undefined>
  createClient?: ImportClientFactory
  now?: Date
}

/** Real read-only preflight. Loads/validates every private file, verifies physical
 * source/target database+storage separation and frozen epoch, then plans against
 * an explicitly empty observation set. This DOES NOT read the CMS destination,
 * create a run, stage files or claim destination reconciliation. */
export async function runImportPreflight(args: readonly string[], dependencies: ImportPreflightDependencies = {}) {
  const parsed = parseImportArguments(args)
  const environment = readImportEnvironment(dependencies.env ?? process.env)
  const manifestPath = await assertPrivatePath(parsed.bundlePath)
  const loaded = requireLoadedBundle(await loadBundle(manifestPath))
  const manifest = loaded.manifest
  const authority = manifest.source.authority
  if (manifest.source.instanceId !== environment.sourceInstance || authority.mode !== 'frozen' ||
    !Number.isSafeInteger(authority.epoch) || authority.epoch < 1) throw new Error('import_source_contract_mismatch')
  const storage = await assertImportStorageIsolation({ ...environment, bundleDirectory: path.dirname(manifestPath) })
  const databases = await preflightImportDatabases(environment, { mode: authority.mode, epoch: authority.epoch }, dependencies.createClient)
  const plan = planLoadedNewsImport(loaded, [], dependencies.now)
  const safeSummary = summarizeImportPlan(plan)
  const expectedEntities = Object.fromEntries(['asset', 'history', 'document', 'home', 'schedule'].map(kind =>
    [kind, plan.expectedItems.filter(item => item.entityKind === kind).length]))
  return { applyRequested: parsed.apply, manifestSha256: loaded.manifestSha256,
    sourceFingerprint: plan.sourceFingerprint, sourceInstance: plan.sourceInstance,
    authorityEpoch: authority.epoch, expectedEntities,
    exceptions: safeSummary.exceptions, sourceHasExceptions: safeSummary.exceptions.length > 0,
    storage, databases }
}

/** Real plan can be produced without --apply. Mutations stay unavailable until
 * primary registers the stabilized schemas/types/migrations and supplies the
 * protected mutation-head reconciliation/control-role receipt plus the remaining
 * source-hash, retention and schedule-worker integration gates. */
export function assertImportApplyReady(_preflight: Awaited<ReturnType<typeof runImportPreflight>>): never {
  throw new Error('import_apply_not_ready')
}
