import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

export function missingFile(error: unknown) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }

/** Existing private root, every ancestor checked, no checkout/public/symlink. */
export async function privateImportDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new Error('import_private_directory_required')
  const absolute = path.resolve(directory)
  for (let current = absolute;; current = path.dirname(current)) {
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.basename(current).toLowerCase() === 'public') {
      throw new Error('import_private_directory_required')
    }
    try { await lstat(path.join(current, '.git')); throw new Error('import_private_directory_required') }
    catch (error) { if (!missingFile(error)) throw error }
    if (path.dirname(current) === current) break
  }
  const canonical = await realpath(absolute)
  if (path.relative(canonical, absolute) !== '') throw new Error('import_private_directory_required')
  return canonical
}

export async function privateImportFile(root: string, relative: string): Promise<string> {
  if (typeof relative !== 'string' || !relative || /[\\\x00-\x1f\x7f:]/u.test(relative) ||
    relative.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative)) {
    throw new Error('invalid_import_relative_path')
  }
  const directory = await privateImportDirectory(root)
  const filename = path.join(directory, ...relative.split('/'))
  await privateImportDirectory(path.dirname(filename))
  const stat = await lstat(filename)
  if (stat.isSymbolicLink() || !stat.isFile() || path.relative(await realpath(filename), filename) !== '') throw new Error('invalid_import_file')
  return filename
}
