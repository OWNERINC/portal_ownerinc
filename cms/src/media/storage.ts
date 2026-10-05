import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { APIError, type Payload } from 'payload'
import { extensions, MAX_MEDIA_BYTES } from './validate-upload'

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
// Next bundles change import.meta.url. npm --prefix cms runs with cwd=cms;
// retain that runtime root as well as the source-module root used by CLI/tests.
const runtimeCheckout = path.basename(process.cwd()) === 'cms' ? path.resolve(process.cwd(), '..') : process.cwd()
export const mediaUnavailable = () => new APIError('media_unavailable', 503, undefined, true)
const inside = (parent: string, child: string) => { const relative = path.relative(parent, child); return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) }

export function privateStorageDir(payload: Payload): string {
  const upload = payload.collections['news-media']?.config.upload
  if (!upload || !upload.staticDir || !path.isAbsolute(upload.staticDir) ||
    [checkout, runtimeCheckout].some(root => inside(root, path.resolve(upload.staticDir!)))) throw mediaUnavailable()
  return path.resolve(upload.staticDir)
}

export async function assertPrivateStorage(payload: Payload) {
  const directory = privateStorageDir(payload)
  const resolved = await realpath(directory)
  // Runtime containment check only: do not let Next trace the entire checkout into a bundle.
  for (const root of [checkout, runtimeCheckout]) if (inside(await realpath(/* turbopackIgnore: true */ root), resolved)) throw mediaUnavailable()
  if ((await lstat(directory)).isSymbolicLink()) throw mediaUnavailable()
  return resolved
}

export type StoredMedia = { filename?: string | null; mimeType?: string | null; filesize?: number | null; sha256?: string | null }
export async function openStoredMedia(payload: Payload, media: StoredMedia) {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const directory = await assertPrivateStorage(payload)
    const { filename, mimeType, filesize, sha256 } = media
    if (!filename || !mimeType || !extensions[mimeType] ||
      !new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${extensions[mimeType]}$`, 'u').test(filename) ||
      !Number.isSafeInteger(filesize) || !filesize || filesize > MAX_MEDIA_BYTES || filesize < 1 || !/^[0-9a-f]{64}$/u.test(sha256 || '')) throw mediaUnavailable()
    const filenamePath = path.join(directory, filename)
    const before = await lstat(filenamePath)
    if (!before.isFile() || before.isSymbolicLink() || await realpath(filenamePath) !== filenamePath) throw mediaUnavailable()
    handle = await open(filenamePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== filesize || stat.ino !== before.ino || stat.dev !== before.dev) throw mediaUnavailable()
    const hash = createHash('sha256')
    // Explicit positions leave the descriptor ready for the later Range stream.
    const chunk = Buffer.alloc(64 * 1024)
    for (let position = 0; position < stat.size;) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - position), position)
      if (!bytesRead) throw mediaUnavailable()
      hash.update(chunk.subarray(0, bytesRead)); position += bytesRead
    }
    if (hash.digest('hex') !== sha256) throw mediaUnavailable()
    return handle
  } catch {
    await handle?.close()
    throw mediaUnavailable()
  }
}
