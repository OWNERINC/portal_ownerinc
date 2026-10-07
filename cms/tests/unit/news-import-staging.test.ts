import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { link, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assertDurablePromotion, stageImportAsset, promoteImportAsset, recordAssetCommitOutcome, resumeStagedImportAsset, verifyImportPromotion } from '../../src/migration/staging'

const bytes = Buffer.from('%PDF-1.7\nsynthetic\n%%EOF\n')
const asset = { id: '11111111-1111-4111-8111-111111111111', mime: 'application/pdf',
  size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), relativePath: 'media/item.pdf' }
const binding = { runId: '22222222-2222-4222-8222-222222222222', manifestSha256: 'a'.repeat(64), authorityEpoch: 2 }

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  // The approved user temp is inside an ancestor .git in this harness. The real
  // outside-checkout guard must not be bypassed just to make fixtures pass.
  const base = process.platform === 'win32' ? path.join(process.env.SystemRoot!, 'Temp') : os.tmpdir()
  const root = await mkdtemp(path.join(base, 'news-import-unit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = path.join(root, 'source'), storageRoot = path.join(root, 'storage')
  await mkdir(path.join(sourceRoot, 'media'), { recursive: true }); await mkdir(storageRoot)
  await writeFile(path.join(sourceRoot, asset.relativePath), bytes)
  return { root, sourceRoot, storageRoot, binding, asset }
}

test('staging restart/promotion/retry retains exact bytes, filename and manifest binding', async t => {
  const input = await fixture(t)
  const staged = await stageImportAsset(input)
  const resumed = await stageImportAsset(input)
  assert.deepEqual(resumed.intent, staged.intent)
  const promoted = await promoteImportAsset(staged)
  await promoteImportAsset(resumed)
  assert.deepEqual(await readFile(path.join(input.storageRoot, promoted.intent.filename)), bytes)
  const verified = await verifyImportPromotion(promoted)
  assert.equal(verified.sha256, asset.sha256)
  assert.equal((await readdir(input.storageRoot)).filter(name => name.endsWith('.pdf')).length, 1)
})

test('unknown COMMIT receipt and promoted/staged bytes survive a subsequent retry', async t => {
  const input = await fixture(t)
  const staged = await promoteImportAsset(await stageImportAsset(input))
  await recordAssetCommitOutcome(staged, 'unknown')
  const retried = await promoteImportAsset(await stageImportAsset(input))
  assert.equal(retried.intent.filename, staged.intent.filename)
  await recordAssetCommitOutcome(retried, 'acknowledged')
  const entries = await readdir(retried.journalDirectory)
  assert.ok(entries.some(name => name.startsWith('commit-unknown-')))
  assert.ok(entries.some(name => name.startsWith('commit-acknowledged-')))
  assert.ok(entries.includes('bytes'))
})

test('existing final file with other bytes is a conflict and never overwritten', async t => {
  const input = await fixture(t)
  const staged = await stageImportAsset(input)
  await writeFile(path.join(input.storageRoot, staged.intent.filename), 'foreign')
  await assert.rejects(promoteImportAsset(staged), /import_asset_conflict/)
  assert.equal(await readFile(path.join(input.storageRoot, staged.intent.filename), 'utf8'), 'foreign')
})

test('identical bytes in an unrelated destination inode do not inherit staged fsync durability', async t => {
  const input = await fixture(t)
  const staged = await stageImportAsset(input)
  const target = path.join(input.storageRoot, staged.intent.filename)
  await writeFile(target, bytes, { flag: 'wx' })
  const before = await lstat(target, { bigint: true })
  const source = await lstat(path.join(staged.journalDirectory, 'bytes'), { bigint: true })
  assert.notEqual(before.ino, source.ino)
  await assert.rejects(promoteImportAsset(staged), /import_asset_conflict/)
  assert.equal((await lstat(target, { bigint: true })).ino, before.ino)
  assert.deepEqual(await readFile(target), bytes)
  assert.equal((await readdir(staged.journalDirectory)).includes('promoted.json'), false)
})

test('restart rejects altered intent binding and corrupted staged bytes', async t => {
  const input = await fixture(t)
  const staged = await stageImportAsset(input)
  await assert.rejects(stageImportAsset({ ...input, binding: { ...binding, authorityEpoch: 3 } }), /import_staging_binding_conflict/)
  const corrupted = Buffer.from(bytes); corrupted[12] ^= 1
  await writeFile(path.join(staged.journalDirectory, 'bytes'), corrupted)
  await assert.rejects(promoteImportAsset(staged), /import_asset_conflict/)
  assert.equal((await readdir(input.storageRoot)).filter(name => name.endsWith('.pdf')).length, 0)
})

test('preflight rejects wrong SHA, size and signature before any promotion', async t => {
  const input = await fixture(t)
  for (const change of [{ sha256: 'b'.repeat(64) }, { size: bytes.length + 1 }, { mime: 'image/png' }]) {
    await assert.rejects(stageImportAsset({ ...input, asset: { ...asset, ...change } }))
  }
  assert.equal((await readdir(input.storageRoot)).filter(name => name.endsWith('.pdf')).length, 0)
})

test('private staging refuses traversal, checkout, public and symlink paths', async t => {
  const input = await fixture(t)
  for (const relativePath of ['../item.pdf', '/item.pdf', 'media\\item.pdf', 'media/./item.pdf', 'media/item.pdf:stream']) {
    await assert.rejects(stageImportAsset({ ...input, asset: { ...asset, relativePath } }), /invalid_import_relative_path/)
  }
  await mkdir(path.join(input.storageRoot, '.git'))
  await assert.rejects(stageImportAsset(input), /import_private_directory_required/)
  await rm(path.join(input.storageRoot, '.git'), { recursive: true })
  const publicRoot = path.join(input.root, 'public'); await mkdir(publicRoot)
  await assert.rejects(stageImportAsset({ ...input, storageRoot: publicRoot }), /import_private_directory_required/)
  const linked = path.join(input.root, 'linked')
  await symlink(input.sourceRoot, linked, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(stageImportAsset({ ...input, sourceRoot: linked }), /import_private_directory_required/)
})

test('restart recovers promotion interrupted before receipt without source or overwrite', async t => {
  const input = await fixture(t)
  const staged = await stageImportAsset(input)
  await link(path.join(staged.journalDirectory, 'bytes'), path.join(input.storageRoot, staged.intent.filename))
  await rm(input.sourceRoot, { recursive: true })
  const resumed = await resumeStagedImportAsset(input)
  assert.equal(resumed.intent.filename, staged.intent.filename)
  const promoted = await promoteImportAsset(resumed)
  assert.deepEqual(await verifyImportPromotion(promoted), { mime: asset.mime, size: asset.size, sha256: asset.sha256 })
  assert.ok((await readdir(staged.journalDirectory)).includes('promoted.json'))
})

test('simultaneous staging uses one immutable journal reservation and final file', async t => {
  const input = await fixture(t)
  const staged = await Promise.all([stageImportAsset(input), stageImportAsset(input)])
  assert.equal(staged[0].intent.filename, staged[1].intent.filename)
  await Promise.all(staged.map(promoteImportAsset))
  assert.equal((await readdir(input.storageRoot)).filter(name => name.endsWith('.pdf')).length, 1)
})

test('apply cannot acknowledge directory durability when only file sync is available', async t => {
  const input = await fixture(t)
  const promoted = await promoteImportAsset(await stageImportAsset(input))
  assert.throws(() => assertDurablePromotion({ ...promoted, directorySynced: false }), /import_directory_durability_unavailable/)
  if (process.platform === 'win32') {
    assert.equal(promoted.directorySynced, false)
    assert.throws(() => assertDurablePromotion(promoted), /import_directory_durability_unavailable/)
  } else assertDurablePromotion(promoted)
})
