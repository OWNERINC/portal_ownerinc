import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { validatePrivateDirectoryStat, validatePrivateEvidenceFileStat } from './integration-config.mjs'

const noFollow = constants.O_NOFOLLOW || 0
const linux = process.platform === 'linux'

function fixedError(code) {
  return Object.assign(new Error(code), { code })
}

function evidencePath(directory, name) {
  if (typeof name !== 'string' || !name || path.basename(name) !== name || name.includes('\0')) {
    throw fixedError('private_evidence_name_invalid')
  }
  return path.join(directory, name)
}

async function readStat(filePath) {
  try { return await lstat(filePath) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw fixedError('private_evidence_file_unavailable')
  }
}

/** Validate exact named artifacts without reading or following an existing path. */
export async function validateExistingPrivateEvidenceFiles(directory, names) {
  const existing = []
  for (const name of names) {
    const filePath = evidencePath(directory, name)
    const info = await readStat(filePath)
    if (!info) continue
    validatePrivateEvidenceFileStat(info)
    existing.push(filePath)
  }
  return existing
}

/** Delete only an explicit artifact allowlist after every existing entry validates. */
export async function removeStalePrivateEvidenceFiles(directory, names) {
  const existing = await validateExistingPrivateEvidenceFiles(directory, names)
  for (const filePath of existing) await unlink(filePath)
}

/** Create or tighten a fixture-owned directory beneath an already-guarded private root. */
export async function ensurePrivateDirectory(directory) {
  if (!path.isAbsolute(directory)) throw fixedError('private_directory_invalid')
  let info = await lstat(directory).catch(error => {
    if (error?.code === 'ENOENT') return null
    throw fixedError('private_directory_unavailable')
  })
  if (!info) {
    try { await mkdir(directory, { mode: 0o700 }) } catch (error) {
      if (error?.code !== 'EEXIST') throw fixedError('private_directory_unavailable')
    }
    info = await lstat(directory).catch(() => null)
  }
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw fixedError('private_directory_invalid')
  if (linux) {
    if (typeof process.getuid !== 'function' || info.uid !== process.getuid()) {
      throw fixedError('private_directory_unsafe')
    }
    if ((info.mode & 0o077) !== 0) await chmod(directory, 0o700)
  }
  const checked = await lstat(directory).catch(() => null)
  validatePrivateDirectoryStat(checked)
}

/** Open, fstat, and read an evidence file without following a symlink. */
export async function readPrivateEvidence(filePath) {
  const initial = await readStat(filePath)
  if (!initial) throw fixedError('private_evidence_file_unavailable')
  validatePrivateEvidenceFileStat(initial)
  let handle
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow)
    const opened = await handle.stat()
    validatePrivateEvidenceFileStat(opened)
    if ((initial.dev !== undefined && initial.dev !== opened.dev) ||
        (initial.ino !== undefined && initial.ino !== opened.ino)) throw fixedError('private_evidence_file_changed')
    return await handle.readFile({ encoding: 'utf8' })
  } catch (error) {
    if (error?.code && /^private_evidence_/u.test(error.code)) throw error
    throw fixedError('private_evidence_file_unavailable')
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Atomically write an evidence artifact. A private same-directory temporary
 * file is exclusively created, chmodded, fsynced and renamed into place.
 */
export async function writePrivateEvidence(filePath, value) {
  if (!path.isAbsolute(filePath) || typeof value !== 'string') throw fixedError('private_evidence_write_invalid')
  const directory = path.dirname(filePath)
  let directoryInfo
  try { directoryInfo = await lstat(directory) } catch { throw fixedError('private_evidence_directory_unavailable') }
  validatePrivateDirectoryStat(directoryInfo)

  const existing = await readStat(filePath)
  if (existing) validatePrivateEvidenceFileStat(existing)

  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  let handle
  let renamed = false
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(value, 'utf8')
    if (linux) await handle.chmod(0o600)
    await handle.sync()
    await handle.close()
    handle = undefined

    await rename(temporary, filePath)
    renamed = true
    // Explicitly reassert the final path mode even when replacing an existing file.
    if (linux) await chmod(filePath, 0o600)
    const finalInfo = await lstat(filePath)
    validatePrivateEvidenceFileStat(finalInfo)
    if (process.platform !== 'win32') {
      let directoryHandle
      try {
        directoryHandle = await open(directory, constants.O_RDONLY)
        await directoryHandle.sync()
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF'].includes(error?.code)) throw error
      } finally {
        await directoryHandle?.close().catch(() => {})
      }
    }
  } catch (error) {
    await handle?.close().catch(() => {})
    if (!renamed) await unlink(temporary).catch(() => {})
    if (error?.code && /^private_evidence_/u.test(error.code)) throw error
    throw fixedError('private_evidence_write_failed')
  }
}
