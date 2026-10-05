import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { APIError, type CollectionBeforeChangeHook, type CollectionBeforeDeleteHook, type CollectionBeforeOperationHook, type PayloadRequest } from 'payload'
import { isLegacyNewsImport } from '../news/validation'
import { assertCmsWriteAuthority } from '../publication/authority'
import { requireCmsTransaction } from '../publication/transaction'
import { assertMediaOrphan } from './references'
import { assertPrivateStorage, openStoredMedia, privateStorageDir } from './storage'
import { extensions, validateUpload } from './validate-upload'

const validated = new WeakMap<PayloadRequest, { mime: string; size: number; sha256: string; filename: string }>()
function refuse(message: string): never { throw new APIError(message, 400, undefined, true) }

export const protectMediaOperation: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (!['create', 'update', 'delete', 'restoreVersion'].includes(operation)) return
  await assertCmsWriteAuthority(req)
  // Deny ALL updates, not just byte fields: native crop/reupload precedes beforeChange.
  if (operation === 'update' || operation === 'restoreVersion') refuse('media_immutable_create_new_asset')
  if (operation === 'delete') {
    if (!('id' in args) || !args.id) refuse('media_delete_requires_single_id')
    // Reference rows are checked before the native operation retrieves the asset.
    await assertMediaOrphan(req.payload, String(args.id), req)
    return
  }
  if (!('data' in args)) refuse('invalid_media_upload')
  const input = args.data as Record<string, unknown>
  const allowed = isLegacyNewsImport(req.context) ? ['legacyAssetId', 'importedAt', 'id'] : []
  if (Object.keys(input).some(key => !allowed.includes(key)) || req.query?.uploadEdits ||
    ('duplicateFromID' in args && args.duplicateFromID) || ('overwriteExistingFiles' in args && args.overwriteExistingFiles)) refuse('media_server_owned_file')
  const file = req.file
  if (!file || file.tempFilePath || !Buffer.isBuffer(file.data) || file.size !== file.data.length) refuse('media_raw_file_required')
  const result = await validateUpload({ bytes: file.data, mime: file.mimetype, filename: file.name })
  const filename = `${randomUUID()}.${extensions[result.mime]}`
  await mkdir(privateStorageDir(req.payload), { recursive: true })
  await assertPrivateStorage(req.payload)
  req.file = { data: file.data, mimetype: result.mime, size: result.size, name: filename }
  validated.set(req, { ...result, filename })
}

export const persistMediaIdentity: CollectionBeforeChangeHook = async ({ data, req }) => {
  await requireCmsTransaction(req.payload, req)
  const result = validated.get(req)
  if (!result || data.filename !== result.filename || data.mimeType !== result.mime || data.filesize !== result.size) refuse('media_bytes_changed')
  data.sha256 = result.sha256
  validated.delete(req)
  return data
}

export const protectMediaDelete: CollectionBeforeDeleteHook = async ({ id, req }) => {
  await requireCmsTransaction(req.payload, req)
  await requireCmsTransaction(req.payload, req)
  const asset = await req.payload.findByID({ collection: 'news-media', id, req, overrideAccess: true, depth: 0 })
  // Before Payload unlinks anything, reject corrupt identity, traversal and symlinks.
  const handle = await openStoredMedia(req.payload, asset)
  await handle.close()
}
