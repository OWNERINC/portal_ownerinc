import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateMedia } from '../import-owner-news.mjs';
import { BundleError, fail, LIMITS, relativePath, sha256 } from './contract.mjs';
import { validateBundle, validateRevisionFile } from './bundle.mjs';

const exists = async name => { try { return await fs.lstat(name); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
/** All ancestors are inspected, including .git FILE markers of linked worktrees. */
export async function assertPrivatePath(value, { existing = true, directory = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value.split(/[\\/]/).includes('..')) fail('private_path_required');
  const absolute = path.resolve(value), root = path.parse(absolute).root;
  if (absolute.slice(root.length).includes(':')) fail('private_path_required');
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    if (part.toLowerCase() === 'public') fail('public_path_forbidden');
    if (await exists(path.join(current, '.git'))) fail('checkout_path_forbidden');
    current = path.join(current, part);
    const stat = await exists(current);
    if (stat?.isSymbolicLink()) fail('symlink_forbidden');
    if (!stat && current !== absolute) fail('private_parent_missing');
  }
  const stat = await exists(absolute);
  if (existing && !stat) fail('private_path_missing');
  if (stat && ((directory && !stat.isDirectory()) || (!directory && !stat.isFile()))) fail('invalid_private_file');
  if (stat?.isDirectory() && await exists(path.join(absolute, '.git'))) fail('checkout_path_forbidden');
  if (stat && path.resolve(await fs.realpath(absolute)) !== absolute) fail('private_path_changed');
  return absolute;
}
function sameStat(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
async function openPrivateFile(filename, maxBytes) {
  const resolved = await assertPrivatePath(filename), before = await fs.lstat(resolved);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) fail('invalid_private_file');
  const handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!sameStat(before, await handle.stat())) fail('private_file_changed');
    return { handle, before, resolved };
  } catch (error) { await handle.close(); throw error; }
}
async function unchanged(file) {
  if (!sameStat(file.before, await file.handle.stat())) fail('private_file_changed');
  await assertPrivatePath(file.resolved);
  if (!sameStat(file.before, await fs.lstat(file.resolved))) fail('private_file_changed');
}
async function readBounded(file) {
  const bytes = Buffer.alloc(file.before.size);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await file.handle.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) fail('private_file_changed');
    offset += bytesRead;
  }
  await unchanged(file);
  return bytes;
}
export async function readPrivateBytes(filename, maxBytes) {
  const file = await openPrivateFile(filename, maxBytes);
  try { return await readBounded(file); } finally { await file.handle.close(); }
}
async function signature(bytes, mime) {
  try {
    if (mime === 'application/pdf') {
      if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') fail('asset_signature_mismatch');
    } else await validateMedia({ buffer: bytes, mime }, mime.startsWith('image/') ? 'image' : 'video');
  } catch { fail('asset_signature_mismatch'); }
}
/** At most ONE bounded media buffer is decoded at a time; copies are streamed. */
export async function inspectAssetFile(filename, { mime, size, sha256: expected = null }, { copyTo = null } = {}) {
  const file = await openPrivateFile(filename, LIMITS.asset);
  let destination;
  try {
    if (file.before.size !== size) fail('asset_size_mismatch');
    let bytes = await readBounded(file);
    const digest = sha256(bytes);
    if (expected !== null && digest !== expected) fail('asset_hash_mismatch');
    await signature(bytes, mime);
    bytes = null;
    if (copyTo !== null) {
      await assertPrivatePath(copyTo, { existing: false });
      destination = await fs.open(copyTo, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      const copied = createHash('sha256'); let count = 0;
      for await (const chunk of file.handle.createReadStream({ start: 0, autoClose: false })) {
        count += chunk.length; if (count > size) fail('private_file_changed');
        copied.update(chunk); await destination.writeFile(chunk);
      }
      await destination.sync(); await destination.close(); destination = null;
      if (count !== size || copied.digest('hex') !== digest) fail('private_file_changed');
      // Re-read ORIGINAL bytes after copying, not just the copied hash.
      if (sha256(await readBounded(file)) !== digest) fail('private_file_changed');
      const written = await inspectAssetFile(copyTo, { mime, size, sha256: digest });
      if (written.sha256 !== digest) fail('asset_hash_mismatch');
    }
    await unchanged(file);
    return { sha256: digest, size, mime };
  } finally {
    if (destination) await destination.close();
    await file.handle.close();
  }
}
export async function writeExclusive(filename, bytes) {
  await assertPrivatePath(filename, { existing: false });
  const file = await fs.open(filename, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
/** No source connection or application startup. Files must be private and local. */
export async function loadBundle(manifestPath) {
  try {
    const bytes = await readPrivateBytes(manifestPath, LIMITS.manifest);
    let manifest;
    try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('invalid_manifest_json'); }
    validateBundle(manifest);
    const root = path.dirname(path.resolve(manifestPath)), revisionById = new Map(), assetPaths = new Map();
    for (const entry of manifest.revisions) {
      const file = path.join(root, relativePath(entry.relativePath));
      revisionById.set(entry.id, validateRevisionFile(manifest, entry, await readPrivateBytes(file, LIMITS.revision)));
    }
    for (const asset of manifest.assets) {
      const file = path.join(root, relativePath(asset.relativePath));
      await inspectAssetFile(file, asset); assetPaths.set(asset.id, file);
    }
    return { manifest, manifestSha256: sha256(bytes), revisionById, assetPaths };
  } catch (error) {
    if (error instanceof BundleError) throw error;
    fail('bundle_file_unavailable');
  }
}
