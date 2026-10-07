import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fail } from './errors.mjs'

const SYSTEM_SID = 'S-1-5-18'

function isAtOrBelow(candidate, parent) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

export async function validateExternalRoot(directory, checkoutRoot, fileSystem = fs) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) {
    fail('directory_must_be_absolute')
  }

  const absolute = path.resolve(directory)
  const parsed = path.parse(absolute)
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let current = parsed.root

  for (const part of parts) {
    current = path.join(current, part)
    let stat
    try { stat = await fileSystem.lstat(current) } catch { fail('directory_root_unavailable') }
    if (stat.isSymbolicLink()) fail('directory_symlink_ancestor')
    if (!stat.isDirectory()) fail('directory_root_unavailable')
  }

  let canonicalRoot
  let canonicalCheckout
  try {
    canonicalRoot = await fileSystem.realpath(absolute)
    canonicalCheckout = await fileSystem.realpath(checkoutRoot)
  } catch { fail('directory_root_unavailable') }

  if (isAtOrBelow(canonicalRoot, canonicalCheckout) || isAtOrBelow(canonicalCheckout, canonicalRoot)) {
    fail('directory_overlaps_checkout')
  }

  let ancestor = canonicalRoot
  while (true) {
    let hasGitMetadata = false
    try {
      await fileSystem.lstat(path.join(ancestor, '.git'))
      hasGitMetadata = true
    } catch (error) {
      if (error?.code !== 'ENOENT') fail('directory_root_unavailable')
    }
    if (hasGitMetadata) fail('directory_overlaps_repository')
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }

  return canonicalRoot
}

export function assertValidPort(value, name) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) fail(`${name}_port_invalid`)
  return value
}

export async function assertLoopbackPortFree(port, createServer = net.createServer) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', error => {
      reject(new Error(error?.code === 'EADDRINUSE' || error?.code === 'EACCES' ? 'port_in_use' : 'port_probe_failed'))
    })
    try {
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        server.close(error => error ? reject(new Error('port_probe_failed')) : resolve())
      })
    } catch {
      reject(new Error('port_probe_failed'))
    }
  }).catch(error => fail(error.message === 'port_in_use' ? 'port_in_use' : 'port_probe_failed'))
}

export function createSecurityContext({ platform = process.platform, spawn = spawnSync, getuid = process.getuid } = {}) {
  if (platform !== 'win32') {
    if (typeof getuid !== 'function') fail('private_owner_unavailable')
    return { platform, spawn }
  }

  let result
  try {
    result = spawn('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch { fail('private_acl_unavailable') }
  if (result?.status !== 0 || result.error) fail('private_acl_unavailable')
  const sid = String(result.stdout || '').match(/\bS-1-(?:\d+-)+\d+\b/u)?.[0]
  if (!sid || sid === SYSTEM_SID) fail('private_acl_unavailable')
  return { platform, spawn, sid }
}

export async function securePath(target, kind, context, fileSystem = fs) {
  if (!['directory', 'file'].includes(kind)) fail('private_acl_unavailable')

  if (context.platform === 'win32') {
    const rights = kind === 'directory' ? '(OI)(CI)F' : 'F'
    let result
    try {
      result = context.spawn('icacls.exe', [
        target,
        '/inheritance:r',
        '/grant:r',
        `*${context.sid}:${rights}`,
        `*${SYSTEM_SID}:${rights}`,
        '/Q',
      ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { fail('private_acl_unavailable') }
    if (result?.status !== 0 || result.error) fail('private_acl_unavailable')
    return
  }

  try {
    await fileSystem.chmod(target, kind === 'directory' ? 0o700 : 0o600)
    const stat = await fileSystem.stat(target)
    const forbidden = kind === 'directory' ? 0o077 : 0o077
    if ((stat.mode & forbidden) !== 0) fail('private_acl_unavailable')
  } catch { fail('private_acl_unavailable') }
}

export async function createSecureDirectory(parent, name, context, fileSystem = fs) {
  const target = path.join(parent, name)
  try { await fileSystem.mkdir(target, { mode: 0o700 }) } catch (error) {
    if (error?.code === 'EEXIST') fail('run_directory_collision')
    fail('run_directory_create_failed')
  }
  await securePath(target, 'directory', context, fileSystem)
  return target
}

export async function createSecureSubdirectory(parent, name, context, fileSystem = fs) {
  const target = path.join(parent, name)
  try { await fileSystem.mkdir(target, { mode: 0o700 }) } catch { fail('artifact_directory_create_failed') }
  await securePath(target, 'directory', context, fileSystem)
  return target
}

export async function writeSecureFile(filePath, contents, context, fileSystem = fs, { utf8Bom = false } = {}) {
  const normalizedContents = utf8Bom
    ? `\uFEFF${contents.replace(/^\uFEFF+/u, '')}`
    : contents
  let handle
  try {
    handle = await fileSystem.open(filePath, 'wx', 0o600)
    await handle.close()
    handle = undefined
  } catch (error) {
    await handle?.close().catch(() => {})
    if (error?.code === 'EEXIST') fail('artifact_collision')
    fail('artifact_create_failed')
  }

  await securePath(filePath, 'file', context, fileSystem)

  try {
    handle = await fileSystem.open(filePath, 'r+')
    await handle.writeFile(normalizedContents, { encoding: 'utf8' })
    await handle.sync()
  } catch { fail('artifact_write_failed') }
  finally { await handle?.close().catch(() => {}) }
}
