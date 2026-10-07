import { APIError, type PayloadRequest } from 'payload'
import { assertDurablePromotion, verifyImportPromotion, type StagedImportAsset } from '../migration/staging'
import { assertPreparationIdentity } from '../publication/authority'
import { requireCmsTransaction } from '../publication/transaction'
import { assertPrivateStorage } from './storage'

type ImportIdentity = Awaited<ReturnType<typeof assertPreparationIdentity>>
type ImportRowIdentity = Readonly<{
  id: string; filename: string; mimeType: string; filesize: number; sha256: string
  legacyAssetId: string; importedAt?: string
}>
type StagedMediaScope = {
  staged: StagedImportAsset
  session: unknown
  identity: ImportIdentity
  rowIdentity?: ImportRowIdentity
  createStarted: boolean
  beforeChangeSeen: boolean
}

const stagedMedia = new WeakMap<PayloadRequest, StagedMediaScope>()
function deny(code: string, status = 403): never {
  throw new APIError(code, status, undefined, true)
}

function sameBinding(staged: StagedImportAsset, identity: ImportIdentity) {
  return staged.intent.runId === identity.runId &&
    staged.intent.manifestSha256 === identity.manifestSha256 &&
    staged.intent.authorityEpoch === identity.expectedEpoch
}

function canonicalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false
  try { return new Date(value).toISOString() === value } catch { return false }
}

function dataDateMatches(value: unknown, expected?: string) {
  if (expected === undefined) return value === undefined || value === null
  if (value instanceof Date) return Number.isFinite(value.getTime()) && value.toISOString() === expected
  return value === expected
}

function assertExactData(data: unknown, staged: StagedImportAsset): ImportRowIdentity {
  if (!data || typeof data !== 'object' || Array.isArray(data)) deny('invalid_staged_media_metadata', 400)
  const input = data as Record<string, unknown>
  const allowed = new Set(['id', 'filename', 'mimeType', 'filesize', 'sha256', 'legacyAssetId', 'importedAt'])
  if (Object.keys(input).some(key => !allowed.has(key)) ||
    input.id !== staged.intent.assetId || input.filename !== staged.intent.filename ||
    input.mimeType !== staged.intent.mime || input.filesize !== staged.intent.size ||
    input.sha256 !== staged.intent.sha256 || input.legacyAssetId !== staged.intent.assetId ||
    (input.importedAt !== undefined && !canonicalDate(input.importedAt))) {
    deny('staged_media_identity_mismatch', 409)
  }
  return Object.freeze({ id: input.id as string, filename: input.filename as string,
    mimeType: input.mimeType as string, filesize: input.filesize as number,
    sha256: input.sha256 as string, legacyAssetId: input.legacyAssetId as string,
    ...(input.importedAt === undefined ? {} : { importedAt: input.importedAt as string }) })
}

async function revalidateScope(req: PayloadRequest, scope: StagedMediaScope) {
  if (scope.session !== await requireCmsTransaction(req.payload, req)) deny('staged_media_transaction_changed', 409)
  const identity = await assertPreparationIdentity(req)
  if (!sameBinding(scope.staged, identity) || identity.runId !== scope.identity.runId ||
    identity.manifestSha256 !== scope.identity.manifestSha256 || identity.expectedEpoch !== scope.identity.expectedEpoch) {
    deny('staged_media_identity_mismatch', 409)
  }
  return scope
}

/** Request-local bridge from a durable promotion to Payload's metadata-only create.
 * It never accepts a serialized capability and never owns/changes the transaction. */
export async function withStagedImportMedia<T>(req: PayloadRequest, staged: StagedImportAsset,
  operation: () => Promise<T>): Promise<T> {
  if (stagedMedia.has(req)) deny('staged_media_scope_active', 409)
  const uploadConfig = req.payload.collections['news-media']?.config.upload
  if (!uploadConfig || typeof uploadConfig !== 'object' || uploadConfig.filesRequiredOnCreate !== false || uploadConfig.disableLocalStorage !== true) {
    deny('staged_media_import_config_required')
  }
  const identity = await assertPreparationIdentity(req)
  if (!sameBinding(staged, identity)) deny('staged_media_identity_mismatch', 409)
  const actualStorageRoot = await assertPrivateStorage(req.payload)
  if (staged.storageRoot !== actualStorageRoot) deny('staged_media_storage_root_mismatch', 409)
  assertDurablePromotion(staged)
  const verified = await verifyImportPromotion(staged)
  if (verified.sha256 !== staged.intent.sha256 || verified.size !== staged.intent.size || verified.mime !== staged.intent.mime) {
    deny('staged_media_bytes_mismatch', 409)
  }
  const session = await requireCmsTransaction(req.payload, req)
  const scope: StagedMediaScope = { staged, session, identity, createStarted: false, beforeChangeSeen: false }
  // Revalidate after filesystem work, immediately before exposing the one-shot scope.
  await revalidateScope(req, scope)
  stagedMedia.set(req, scope)
  try {
    const result = await operation()
    await revalidateScope(req, scope)
    if (!scope.createStarted || !scope.beforeChangeSeen) deny('staged_media_create_not_completed', 409)
    return result
  } finally { stagedMedia.delete(req) }
}

/** Called from Payload's beforeOperation. This is intentionally private to the
 * server hook path; request context/JSON fields cannot create a WeakMap entry. */
export async function assertStagedMediaCreate(req: PayloadRequest, args: Record<string, unknown>) {
  const scope = stagedMedia.get(req)
  if (!scope) deny('staged_media_context_required')
  await revalidateScope(req, scope)
  if (scope.createStarted) deny('staged_media_create_reused', 409)
  const rowIdentity = assertExactData(args.data, scope.staged)
  if (req.file !== undefined || req.query?.uploadEdits || args.duplicateFromID || args.overwriteExistingFiles) {
    deny('staged_media_file_input_forbidden', 400)
  }
  scope.rowIdentity = rowIdentity
  scope.createStarted = true
}

/** Called after Payload's native generateFileData. Cross-check every generated
 * identity field so native transformations cannot rename/re-encode the asset. */
export async function assertStagedMediaBeforeChange(req: PayloadRequest, data: Record<string, unknown>) {
  const scope = stagedMedia.get(req)
  if (!scope || !scope.rowIdentity) deny('staged_media_context_required')
  await revalidateScope(req, scope)
  const expected = scope.rowIdentity
  if (scope.beforeChangeSeen || data.id !== expected.id || data.filename !== expected.filename ||
    data.mimeType !== expected.mimeType || data.filesize !== expected.filesize || data.sha256 !== expected.sha256 ||
    data.legacyAssetId !== expected.legacyAssetId || !dataDateMatches(data.importedAt, expected.importedAt)) {
    deny('staged_media_generated_identity_mismatch', 409)
  }
  scope.beforeChangeSeen = true
}

export function hasStagedImportMedia(req: PayloadRequest) { return stagedMedia.has(req) }
